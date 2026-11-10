import { createHash } from "node:crypto";
import type { Actor, TenantTx } from "@abcrm/db";
import { recordUsage, uuidv7, type TenantKeyring } from "@abcrm/core";
import { createAccount } from "@abcrm/crm";
import type { Findings } from "./examine.js";

export const CREDITS = { candidate_sourced: 2 } as const;

export type DedupeReason = "existing_account" | "blocklisted" | "competitor" | "existing_buyer" | "recently_contacted" | "suppressed_domain";
export type RecordResult = { candidateId: string | null; accountId: string; status: "found" | "deduped" | "duplicate_in_run"; reason?: DedupeReason; credits: number };

/**
 * Turns findings into an account + candidate + evidence in the tenant's space, applying dedupe rules
 * (tools.md §3.1). Idempotent per (run, account): a retried step returns the existing candidate.
 */
export async function recordCandidate(
  tx: TenantTx, keyring: TenantKeyring, actor: Actor, runId: string, f: Findings, opts: { vertical: string; excludedDomains: string[]; query?: string; agentDefinitionId?: string },
): Promise<RecordResult> {
  const { account, created } = await createAccount(tx, keyring, actor, {
    name: f.name, domain: f.domain, verticals: [opts.vertical], source: { kind: "sourcing", sourcing_run_id: runId } }, "return");

  const existing = await tx.client.query<{ id: string; status: string }>(
    "SELECT id, status FROM abcrm.candidates WHERE sourcing_run_id = $1 AND account_id = $2", [runId, account.id]);
  if (existing.rows[0]) return { candidateId: existing.rows[0].id, accountId: account.id, status: "duplicate_in_run", credits: 0 };

  let reason: DedupeReason | undefined;
  if (opts.excludedDomains.includes(account.domain) || account.flags.includes("do_not_contact")) reason = "blocklisted";
  else if (account.flags.includes("competitor")) reason = "competitor";
  else if (account.flags.includes("existing_buyer")) reason = "existing_buyer";
  else if (!created && account.status !== "prospect") reason = "existing_account";
  else {
    const { rowCount } = await tx.client.query(
      "SELECT 1 FROM abcrm.suppression_entries WHERE kind = 'domain' AND value_bidx = $1", [await keyring.bidx(tx, "domain", account.domain)]);
    if (rowCount) reason = "suppressed_domain";
    else {
      const recent = await tx.client.query(
        "SELECT 1 FROM abcrm.accounts WHERE id = $1 AND (last_contacted_at > now() - interval '90 days' OR cooldown_until > now())", [account.id]);
      if (recent.rowCount) reason = "recently_contacted";
    }
  }

  // Merge what we learned onto the account without overwriting values a person set.
  await tx.client.query(
    `UPDATE abcrm.accounts SET tech_signals = tech_signals || $2,
       lead_types = CASE WHEN cardinality(lead_types) = 0 THEN $3 ELSE lead_types END,
       buyer_type = coalesce(buyer_type, $4), hq_country = coalesce(hq_country, $5), hq_state = coalesce(hq_state, $6),
       employee_range = coalesce(employee_range, $7)
     WHERE id = $1`, [account.id, JSON.stringify(f.tech), f.leadTypes, f.facts?.buyerType ?? null, f.facts?.hqCountry ?? null,
      f.facts?.hqState ?? null, f.facts?.employeeRange ?? null]);

  const candidateId = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.candidates(id, tenant_id, sourcing_run_id, account_id, discovered_via, status, dedupe_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [candidateId, tx.tenantId, runId, account.id, { kind: "search", query: opts.query ?? null }, reason ? "deduped" : "found", reason ?? null]);

  for (const s of f.snippets) {
    const hash = createHash("sha256").update(s.text).digest();
    const dup = await tx.client.query("SELECT 1 FROM abcrm.evidence WHERE account_id = $1 AND content_hash = $2", [account.id, hash]);
    if (dup.rowCount) continue;
    await tx.client.query(
      `INSERT INTO abcrm.evidence(id, tenant_id, account_id, kind, url, retrieved_at, snippet, content_hash, public_page_id)
       VALUES ($1, $2, $3, 'web_page', $4, now(), $5, $6, $7)`, [uuidv7(), tx.tenantId, account.id, s.url, s.text, hash, s.pageId]);
  }
  for (const [key, v] of Object.entries(f.tech)) {
    const text = `${key}: ${v.match}`;
    const hash = createHash("sha256").update(text).digest();
    const dup = await tx.client.query("SELECT 1 FROM abcrm.evidence WHERE account_id = $1 AND content_hash = $2", [account.id, hash]);
    if (!dup.rowCount) {
      await tx.client.query(
        `INSERT INTO abcrm.evidence(id, tenant_id, account_id, kind, url, retrieved_at, snippet, content_hash)
         VALUES ($1, $2, $3, 'tech_signal', $4, now(), $5, $6)`, [uuidv7(), tx.tenantId, account.id, `https://${f.domain}/`, text, hash]);
    }
  }

  let credits = 0;
  if (!reason) {
    credits = CREDITS.candidate_sourced;
    await recordUsage(tx, { idempotencyKey: `srun:${runId}:cand:${account.id}`, meter: "agent", actionType: "candidate_sourced",
      credits, sourcingRunId: runId, agentDefinitionId: opts.agentDefinitionId ?? null });
  }
  return { candidateId, accountId: account.id, status: reason ? "deduped" : "found", reason, credits };
}
