import { createHash } from "node:crypto";
import type { Actor, TenantTx } from "@abcrm/db";
import { canonicalJson } from "./canonical-json.js";
import { uuidv7 } from "./ids.js";

export type AuditEntry = { actor: Actor; action: string; subject: { type: string; id: string } };

/**
 * Appends to the per-tenant hash chain: hash = sha256(prev_hash || canonical(entry)).
 * A transaction-scoped advisory lock serializes appends per tenant so the chain never forks.
 */
export async function appendAudit(tx: TenantTx, entry: AuditEntry): Promise<{ id: string; hash: Buffer }> {
  await tx.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`audit:${tx.tenantId}`]);
  const prev = await tx.client.query<{ hash: Buffer; at: string }>(
    `SELECT hash, at::text AS at FROM abcrm.audit_log ORDER BY at DESC LIMIT 1`);
  const prevHash = prev.rows[0]?.hash ?? null;
  // `at` is strictly increasing per tenant (µs resolution), so ORDER BY at reproduces the chain order.
  const { rows: [clock] } = await tx.client.query<{ at: string }>(
    `SELECT ${AT_TEXT.replace("$col", "GREATEST(clock_timestamp(), $1::timestamptz + interval '1 microsecond')")} AS at`,
    [prev.rows[0]?.at ?? "-infinity"]);
  const at = clock!.at;
  const id = uuidv7();
  const hash = chainHash(prevHash, { id, tenantId: tx.tenantId, at, ...entry });
  await tx.client.query(
    "INSERT INTO abcrm.audit_log(id, tenant_id, at, actor, action, subject, prev_hash, hash) VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8)",
    [id, tx.tenantId, at, entry.actor, entry.action, entry.subject, prevHash, hash],
  );
  return { id, hash };
}

/** Canonical UTC text with microseconds, used both when hashing and when verifying. */
const AT_TEXT = `to_char(($col) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function chainHash(prevHash: Buffer | null, row: unknown): Buffer {
  return createHash("sha256").update(prevHash ?? Buffer.alloc(0)).update(canonicalJson(row)).digest();
}

/** Recomputes the chain for the current tenant; returns the id of the first broken link, or null. */
export async function verifyAuditChain(tx: TenantTx): Promise<string | null> {
  const { rows } = await tx.client.query<{
    id: string; tenant_id: string; at: string; actor: Actor; action: string; subject: AuditEntry["subject"]; prev_hash: Buffer | null; hash: Buffer;
  }>(`SELECT id, tenant_id, ${AT_TEXT.replace("$col", "at")} AS at, actor, action, subject, prev_hash, hash
      FROM abcrm.audit_log ORDER BY abcrm.audit_log.at`);
  let prev: Buffer | null = null;
  for (const r of rows) {
    const expected = chainHash(prev, { id: r.id, tenantId: r.tenant_id, at: r.at, actor: r.actor, action: r.action, subject: r.subject });
    const prevOk = (prev === null && r.prev_hash === null) || (prev !== null && r.prev_hash !== null && prev.equals(r.prev_hash));
    if (!prevOk || !expected.equals(r.hash)) return r.id;
    prev = r.hash;
  }
  return null;
}
