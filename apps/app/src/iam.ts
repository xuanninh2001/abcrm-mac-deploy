import { appendAudit, emit, notify, Problem, notFound, uuidv7 } from "@abcrm/core";
import type { Actor, TenantTx } from "@abcrm/db";
import type { Principal, Role } from "@abcrm/agents";
import { assignCard } from "@abcrm/inbox";
import type { WorkosDirectory } from "./workos.js";
import { hashPassword } from "@abcrm/crypto";

export type UserRow = {
  id: string; email: string; name: string | null; role: Role; status: "invited" | "active" | "disabled"; timezone: string;
  working_hours: Record<string, [string, string]>; locale: string; invited_at: Date | null; activated_at: Date | null;
};
const COLS = "id, email, name, role, status, timezone, working_hours, locale, invited_at, activated_at";

/** Placeholder identity until the invitee's first WorkOS sign-in binds the real one (migration 0010). */
const INVITE_PREFIX = "invite:";

export async function listUsers(tx: TenantTx, opts: { all: boolean }): Promise<UserRow[]> {
  return (await tx.client.query<UserRow>(
    `SELECT ${COLS} FROM abcrm.users ${opts.all ? "" : "WHERE status = 'active'"} ORDER BY status = 'disabled', role, email`)).rows;
}

async function load(tx: TenantTx, id: string, lock = false): Promise<UserRow & { workos_user_id: string }> {
  const { rows: [u] } = await tx.client.query<UserRow & { workos_user_id: string }>(
    `SELECT ${COLS}, workos_user_id FROM abcrm.users WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!u) throw notFound("User");
  return u;
}

const callerRole = (p: Principal): Role => {
  if (p.type !== "user") throw new Problem("permission-denied", "Only people manage users");
  return p.role;
};

/**
 * POST /users: creates an invited user and, when WorkOS is configured and the tenant has an organization,
 * sends the WorkOS invitation email. Only an owner can invite another owner.
 */
export async function inviteUser(tx: TenantTx, actor: Actor, principal: Principal, directory: WorkosDirectory | undefined,
  input: { email: string; name?: string; role: Role; timezone?: string; password?: string }) {
  if (input.role === "owner" && callerRole(principal) !== "owner") throw new Problem("permission-denied", "Only an owner can invite an owner");
  const email = input.email.trim().toLowerCase();
  const { rows: [dup] } = await tx.client.query<{ status: string }>("SELECT status FROM abcrm.users WHERE email = $1", [email]);
  if (dup) throw new Problem("conflict", `A user with this email already exists (${dup.status})`);
  const id = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, name, role, timezone, status, invited_by, invited_at)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, 'Asia/Ho_Chi_Minh'), 'invited', $8, now())`,
    [id, tx.tenantId, `${INVITE_PREFIX}${id}`, email, input.name ?? null, input.role, input.timezone ?? null, principal.id]);
  await appendAudit(tx, { actor, action: "user.invited", subject: { type: "user", id } });
  await emit(tx, "iam.user.invited", { user_id: id, role: input.role });
  if (input.password) {
    await tx.client.query("SELECT abcrm.local_initialize_user($1,$2)", [id, await hashPassword(input.password)]);
    await recordActivation(tx, id);
  }
  const invitation = input.password ? { sent: false, reason: "local_account_created" } : await sendInvite(tx, directory, email);
  return { user: await load(tx, id).then(strip), invitation };
}

/** POST /users/{id}/resend-invite. */
export async function resendInvite(tx: TenantTx, directory: WorkosDirectory | undefined, id: string) {
  const u = await load(tx, id);
  if (u.status !== "invited") throw new Problem("conflict", `User is ${u.status}`);
  await tx.client.query("UPDATE abcrm.users SET invited_at = now() WHERE id = $1", [id]);
  return { user: strip(u), invitation: await sendInvite(tx, directory, u.email) };
}

async function sendInvite(tx: TenantTx, directory: WorkosDirectory | undefined, email: string) {
  const { rows: [t] } = await tx.client.query<{ workos_org_id: string | null }>("SELECT workos_org_id FROM abcrm.tenants WHERE id = $1", [tx.tenantId]);
  if (!directory) return { sent: false, reason: "local_password_required" };
  if (!t?.workos_org_id) return { sent: false, reason: "tenant_has_no_workos_organization" };
  try {
    const r = await directory.invite({ email, organizationId: t.workos_org_id });
    return { sent: true, id: r.id };
  } catch (e) {
    // The user row stays (the admin can resend); surface the failure instead of hiding it.
    throw new Problem("internal", "Could not send the WorkOS invitation; try resending", { cause: String((e as Error).message ?? e) });
  }
}

const strip = ({ workos_user_id: _w, ...u }: UserRow & { workos_user_id: string }): UserRow => u;

/**
 * PATCH /users/{id} by owner/admin: role and status. Guards against lock-out: nobody changes their own role or
 * disables themselves; only owners touch owners; the last active owner stays. Disabling hands the user's pending
 * cards to the next rep in rotation.
 */
export async function updateUser(tx: TenantTx, actor: Actor, principal: Principal, id: string,
  patch: { role?: Role; status?: "active" | "disabled"; name?: string | null }) {
  const role = callerRole(principal);
  const u = await load(tx, id, true);
  if (id === principal.id && (patch.role !== undefined && patch.role !== u.role || patch.status === "disabled")) {
    throw new Problem("conflict", "You cannot change your own role or disable yourself");
  }
  if ((u.role === "owner" || patch.role === "owner") && role !== "owner") throw new Problem("permission-denied", "Only an owner can change owners");
  const losesOwner = u.role === "owner" && u.status === "active" && (patch.role !== undefined && patch.role !== "owner" || patch.status === "disabled");
  if (losesOwner) {
    const { rows: [n] } = await tx.client.query<{ n: number }>("SELECT count(*)::int AS n FROM abcrm.users WHERE role = 'owner' AND status = 'active' AND id <> $1", [id]);
    if (!n!.n) throw new Problem("conflict", "The tenant needs at least one active owner");
  }
  // Re-enabling a never-activated invite puts it back to 'invited'.
  const neverActivated = u.workos_user_id.startsWith(INVITE_PREFIX) && !u.activated_at;
  const status = patch.status === "active" && neverActivated ? "invited" : patch.status;
  await tx.client.query(
    `UPDATE abcrm.users SET role = coalesce($2, role), status = coalesce($3, status), name = CASE WHEN $4 THEN $5 ELSE name END WHERE id = $1`,
    [id, patch.role ?? null, status ?? null, patch.name !== undefined, patch.name ?? null]);
  if (patch.role && patch.role !== u.role) await appendAudit(tx, { actor, action: "user.role_changed", subject: { type: "user", id } });
  let reassigned = 0;
  if (status && status !== u.status) {
    await appendAudit(tx, { actor, action: status === "disabled" ? "user.disabled" : "user.enabled", subject: { type: "user", id } });
    await emit(tx, status === "disabled" ? "iam.user.disabled" : "iam.user.enabled", { user_id: id });
    if (status === "disabled") reassigned = await handOffCards(tx, id);
  }
  return { user: strip(await load(tx, id)), cards_reassigned: reassigned };
}

async function handOffCards(tx: TenantTx, userId: string): Promise<number> {
  const { rows } = await tx.client.query<{ card_id: string }>(
    "SELECT DISTINCT card_id FROM abcrm.decisions WHERE assignee_user_id = $1 AND status = 'pending' AND card_id IS NOT NULL", [userId]);
  for (const r of rows) await assignCard(tx, r.card_id);
  return rows.length;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_KEY = /^(sun|mon|tue|wed|thu|fri|sat)(-(sun|mon|tue|wed|thu|fri|sat))?$/;

/** PATCH /users/me: a person's own profile. Timezone and working hours drive card SLAs and the morning digest. */
export async function updateProfile(tx: TenantTx, principal: Principal,
  patch: { name?: string | null; timezone?: string; locale?: "en" | "vi"; working_hours?: Record<string, [string, string]> }) {
  if (principal.type !== "user") throw new Problem("permission-denied", "Profiles belong to people");
  if (patch.timezone !== undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: patch.timezone }); } catch { throw new Problem("validation-failed", "Unknown timezone"); }
  }
  if (patch.working_hours !== undefined) {
    const entries = Object.entries(patch.working_hours);
    if (!entries.length) throw new Problem("validation-failed", "Working hours need at least one day range");
    for (const [k, [a, b]] of entries) {
      if (!DAY_KEY.test(k) || !TIME.test(a) || !TIME.test(b) || a >= b) throw new Problem("validation-failed", `Invalid working hours for ${k}`);
    }
  }
  await tx.client.query(
    `UPDATE abcrm.users SET name = CASE WHEN $2 THEN $3 ELSE name END, timezone = coalesce($4, timezone), locale = coalesce($5, locale),
       working_hours = coalesce($6, working_hours) WHERE id = $1`,
    [principal.id, patch.name !== undefined, patch.name ?? null, patch.timezone ?? null, patch.locale ?? null,
      patch.working_hours ? JSON.stringify(patch.working_hours) : null]);
  return strip(await load(tx, principal.id));
}

/** After a first sign-in bound an invite (or a dev sign-in of an invited user): record it and tell the inviter. */
export async function recordActivation(tx: TenantTx, userId: string) {
  const { rows: [u] } = await tx.client.query<{ role: string; email: string; invited_by: string | null }>(
    "SELECT role, email, invited_by FROM abcrm.users WHERE id = $1", [userId]);
  if (!u) return;
  await appendAudit(tx, { actor: { type: "user", id: userId }, action: "user.activated", subject: { type: "user", id: userId } });
  await emit(tx, "iam.user.activated", { user_id: userId, role: u.role });
  if (u.invited_by) {
    await notify(tx, { userId: u.invited_by, kind: "user_activated", title: `${u.email} joined`, body: `They signed in as ${u.role.replace("_", " ")}.`,
      payload: { user_id: userId }, email: false });
  }
}
