import type { Actor, TenantTx } from "@abcrm/db";
import { appendAudit, emit, notFound, Problem, uuidv7, type TenantKeyring } from "@abcrm/core";
import { normalizeDomain } from "@abcrm/crypto";
import { recordChanges } from "./changes.js";

export const ACCOUNT_COLUMNS =
  "id, name, domain, buyer_type, verticals, lead_types, hq_state, hq_country, employee_range, status, flags, owner_user_id, source, created_at, updated_at";

export type Account = {
  id: string; name: string; domain: string; buyer_type: string | null; verticals: string[]; lead_types: string[];
  hq_state: string | null; hq_country: string | null; employee_range: string | null; status: string; flags: string[];
  owner_user_id: string | null; source: Record<string, unknown>; created_at: Date; updated_at: Date;
};

export const ACCOUNT_FLAGS = ["competitor", "existing_buyer", "do_not_contact"] as const;
export type AccountFlag = (typeof ACCOUNT_FLAGS)[number];

export type AccountInput = {
  name: string; domain: string; hqState?: string | null; hqCountry?: string | null; buyerType?: string | null;
  employeeRange?: string | null; verticals?: string[]; flags?: AccountFlag[]; source?: Record<string, unknown>;
};

/** Domain → bidx; throws a 422 problem for unusable domains. */
export async function domainKey(tx: TenantTx, keyring: TenantKeyring, raw: string) {
  let domain: string;
  try { domain = normalizeDomain(raw); } catch { throw new Problem("validation-failed", "Invalid domain", { domain: raw }); }
  return { domain, bidx: await keyring.bidx(tx, "domain", domain) };
}

/**
 * Creates an account, or with `ifExists: "return"` returns the existing one for the same registrable domain
 * (imports and sourcing upsert; the API reports a conflict).
 */
export async function createAccount(
  tx: TenantTx, keyring: TenantKeyring, actor: Actor, input: AccountInput, ifExists: "conflict" | "return" = "conflict",
): Promise<{ account: Account; created: boolean }> {
  const { domain, bidx } = await domainKey(tx, keyring, input.domain);
  const id = uuidv7();
  const res = await tx.client.query<Account>(
    `INSERT INTO abcrm.accounts(id, tenant_id, name, domain, domain_bidx, hq_state, hq_country, buyer_type, employee_range, verticals, flags, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, domain_bidx) DO NOTHING RETURNING ${ACCOUNT_COLUMNS}`,
    [id, tx.tenantId, input.name, domain, bidx, input.hqState ?? null, input.hqCountry ?? null, input.buyerType ?? null,
      input.employeeRange ?? null, input.verticals ?? [], input.flags ?? [], input.source ?? { kind: "manual" }]);
  if (res.rows[0]) {
    await appendAudit(tx, { actor, action: "account.created", subject: { type: "account", id } });
    await emit(tx, "crm.account.created", { account_id: id });
    return { account: res.rows[0], created: true };
  }
  if (ifExists === "conflict") throw new Problem("conflict", "An account with this domain already exists", { domain });
  const existing = await tx.client.query<Account>(`SELECT ${ACCOUNT_COLUMNS} FROM abcrm.accounts WHERE domain_bidx = $1`, [bidx]);
  return { account: existing.rows[0]!, created: false };
}

export async function getAccount(tx: TenantTx, id: string): Promise<Account> {
  const { rows: [a] } = await tx.client.query<Account>(`SELECT ${ACCOUNT_COLUMNS} FROM abcrm.accounts WHERE id = $1`, [id]);
  if (!a) throw notFound("Account");
  return a;
}

export async function listAccounts(tx: TenantTx, opts: { cursor?: string; limit: number; q?: string; status?: string; flag?: string }) {
  const { rows } = await tx.client.query<Account>(
    `SELECT ${ACCOUNT_COLUMNS} FROM abcrm.accounts
     WHERE ($1::uuid IS NULL OR id > $1::uuid)
       AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR domain ILIKE '%' || $3 || '%')
       AND ($4::text IS NULL OR status = $4)
       AND ($5::text IS NULL OR $5 = ANY(flags))
     ORDER BY id LIMIT $2`,
    [opts.cursor ?? null, opts.limit + 1, opts.q ?? null, opts.status ?? null, opts.flag ?? null]);
  const page = rows.slice(0, opts.limit);
  return { data: page, next_cursor: rows.length > opts.limit ? page.at(-1)!.id : null };
}

export type AccountPatch = Partial<{
  name: string; buyer_type: string | null; verticals: string[]; lead_types: string[]; hq_state: string | null;
  hq_country: string | null; employee_range: string | null; owner_user_id: string | null; status: "lost" | "blocked" | "prospect";
}>;

const PATCHABLE: ReadonlySet<string> = new Set(["name", "buyer_type", "verticals", "lead_types", "hq_state", "hq_country", "employee_range", "owner_user_id", "status"]);

export async function updateAccount(tx: TenantTx, actor: Actor, id: string, patch: AccountPatch): Promise<Account> {
  const before = await getAccount(tx, id);
  // Column names are interpolated below, so only allowlisted keys may pass.
  const fields = (Object.keys(patch) as (keyof AccountPatch)[]).filter((f) => PATCHABLE.has(f) && patch[f] !== undefined);
  if (fields.length === 0) return before;
  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const { rows: [after] } = await tx.client.query<Account>(
    `UPDATE abcrm.accounts SET ${sets} WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`, [id, ...fields.map((f) => patch[f])]);
  const changed = await recordChanges(tx, actor, "account", id, before, after!);
  if (changed.length) await emit(tx, "crm.account.updated", { account_id: id, fields: changed });
  return after!;
}

export async function setAccountFlags(tx: TenantTx, actor: Actor, id: string, add: AccountFlag[], remove: AccountFlag[]): Promise<Account> {
  const before = await getAccount(tx, id);
  const flags = [...new Set([...before.flags.filter((f) => !remove.includes(f as AccountFlag)), ...add])].sort();
  const { rows: [after] } = await tx.client.query<Account>(
    `UPDATE abcrm.accounts SET flags = $2 WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`, [id, flags]);
  if ((await recordChanges(tx, actor, "account", id, { flags: before.flags }, { flags })).length) {
    await appendAudit(tx, { actor, action: "account.flags_changed", subject: { type: "account", id } });
  }
  return after!;
}
