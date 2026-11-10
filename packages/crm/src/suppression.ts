import type { Actor, TenantTx } from "@abcrm/db";
import { appendAudit, emit, notFound, Problem, uuidv7, type TenantKeyring } from "@abcrm/core";
import { normalizeDomain, normalizeEmail } from "@abcrm/crypto";

export type SuppressionKind = "email" | "domain";
export type SuppressionReason =
  | "unsubscribe" | "bounce" | "complaint" | "dsar" | "manual" | "competitor" | "existing_buyer" | "import";

/** Entries created for legal reasons (opt-out, complaint, data-subject requests) can never be removed. */
const PERMANENT: ReadonlySet<SuppressionReason> = new Set(["unsubscribe", "complaint", "dsar"]);

export function normalizeSuppressionValue(kind: SuppressionKind, value: string): string {
  try { return kind === "email" ? normalizeEmail(value) : normalizeDomain(value); }
  catch { throw new Problem("validation-failed", `Invalid ${kind}`, { value }); }
}

/**
 * Adds (idempotently) a tenant suppression entry and marks matching contacts suppressed. A domain entry
 * suppresses every contact of accounts on that domain.
 */
export async function addSuppression(
  tx: TenantTx, keyring: TenantKeyring, actor: Actor,
  input: { kind: SuppressionKind; value: string; reason: SuppressionReason; source?: Record<string, unknown> },
): Promise<{ id: string; created: boolean; contactsSuppressed: number }> {
  const value = normalizeSuppressionValue(input.kind, input.value);
  const bidx = await keyring.bidx(tx, input.kind, value);
  const id = uuidv7();
  const ins = await tx.client.query<{ id: string }>(
    `INSERT INTO abcrm.suppression_entries(id, tenant_id, kind, value_bidx, value_enc, reason, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, kind, value_bidx) DO NOTHING RETURNING id`,
    [id, tx.tenantId, input.kind, bidx, await keyring.encrypt(tx, "suppression_entries.value", value), input.reason,
      input.source ?? {}, actor]);

  const affected = input.kind === "email"
    ? await tx.client.query("UPDATE abcrm.contacts SET status = 'suppressed' WHERE email_bidx = $1 AND status = 'active'", [bidx])
    : await tx.client.query(
      `UPDATE abcrm.contacts c SET status = 'suppressed' FROM abcrm.accounts a
       WHERE c.account_id = a.id AND a.domain_bidx = $1 AND c.status = 'active'`, [await keyring.bidx(tx, "domain", value)]);

  if (ins.rows[0]) {
    await appendAudit(tx, { actor, action: "suppression.added", subject: { type: "suppression", id } });
    await emit(tx, "crm.suppression.added", { suppression_id: id, kind: input.kind, reason: input.reason });
  }
  return { id: ins.rows[0]?.id ?? id, created: !!ins.rows[0], contactsSuppressed: affected.rowCount ?? 0 };
}

export async function removeSuppression(tx: TenantTx, actor: Actor, id: string): Promise<void> {
  const { rows: [e] } = await tx.client.query<{ reason: SuppressionReason }>("SELECT reason FROM abcrm.suppression_entries WHERE id = $1", [id]);
  if (!e) throw notFound("Suppression entry");
  if (PERMANENT.has(e.reason)) throw new Problem("conflict", `Entries with reason '${e.reason}' cannot be removed`);
  await tx.client.query("DELETE FROM abcrm.suppression_entries WHERE id = $1", [id]);
  // Contacts are not auto-reactivated: someone must review them deliberately.
  await appendAudit(tx, { actor, action: "suppression.removed", subject: { type: "suppression", id } });
}

export async function listSuppression(tx: TenantTx, keyring: TenantKeyring, opts: { kind?: SuppressionKind; limit: number; cursor?: string }) {
  const { rows } = await tx.client.query<{ id: string; kind: SuppressionKind; value_enc: Buffer | null; reason: string; created_at: Date }>(
    `SELECT id, kind, value_enc, reason, created_at FROM abcrm.suppression_entries
     WHERE ($1::text IS NULL OR kind = $1) AND ($2::uuid IS NULL OR id > $2::uuid) ORDER BY id LIMIT $3`,
    [opts.kind ?? null, opts.cursor ?? null, opts.limit + 1]);
  const page = await Promise.all(rows.slice(0, opts.limit).map(async (r) => ({
    id: r.id, kind: r.kind, reason: r.reason, created_at: r.created_at,
    value: r.value_enc ? await keyring.decrypt(tx, "suppression_entries.value", r.value_enc) : null,
  })));
  return { data: page, next_cursor: rows.length > opts.limit ? page.at(-1)!.id : null };
}

/** True if the email itself or its domain is suppressed for this tenant. */
export async function isSuppressed(tx: TenantTx, keyring: TenantKeyring, email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const domain = normalizeDomain(e);
  const { rowCount } = await tx.client.query(
    `SELECT 1 FROM abcrm.suppression_entries WHERE (kind = 'email' AND value_bidx = $1) OR (kind = 'domain' AND value_bidx = $2) LIMIT 1`,
    [await keyring.bidx(tx, "email", e), await keyring.bidx(tx, "domain", domain)]);
  return (rowCount ?? 0) > 0;
}
