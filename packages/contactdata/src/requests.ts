import type { Actor, TenantTx } from "@abcrm/db";
import { emit, notFound, Problem, uuidv7 } from "@abcrm/core";

/**
 * POST /accounts/{id}/contacts/find: records a reserved lookup; the worker runs the waterfall (vendor calls
 * and the global cache stay out of the request path). Titles default to the active IPP's contact titles.
 */
export async function requestLookup(tx: TenantTx, _actor: Actor, input: { accountId: string; titles?: string[]; limit: number }) {
  const { rowCount } = await tx.client.query("SELECT 1 FROM abcrm.accounts WHERE id = $1", [input.accountId]);
  if (!rowCount) throw notFound("Account");
  let titles = input.titles?.filter((t) => t.trim()).slice(0, 10) ?? [];
  if (!titles.length) {
    const { rows: [ipp] } = await tx.client.query<{ contact_titles: string[] }>(
      "SELECT contact_titles FROM abcrm.ipps WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1");
    titles = ipp?.contact_titles ?? [];
  }
  if (!titles.length) throw new Problem("validation-failed", "titles are required when no IPP is active");
  const limit = Math.min(Math.max(input.limit, 1), 5);
  const id = uuidv7();
  await tx.client.query(
    "INSERT INTO abcrm.contact_lookups(id, tenant_id, account_id, titles, limit_n, status) VALUES ($1, $2, $3, $4, $5, 'reserved')",
    [id, tx.tenantId, input.accountId, titles, limit]);
  await emit(tx, "contactdata.lookup.requested", { contact_lookup_id: id, account_id: input.accountId, titles, limit });
  return getLookup(tx, id);
}

export async function getLookup(tx: TenantTx, id: string) {
  const { rows: [l] } = await tx.client.query(
    `SELECT id, account_id, candidate_id, titles, limit_n AS limit, status, providers_tried, results, contact_credits::float AS contact_credits, created_at, updated_at
     FROM abcrm.contact_lookups WHERE id = $1`, [id]);
  if (!l) throw notFound("Contact lookup");
  return l;
}
