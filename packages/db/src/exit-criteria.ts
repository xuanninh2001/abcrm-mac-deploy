import type { Pool } from "./pool.js";

/** Phase 1 exit criteria (docs/specs/phase-0-1/README.md §4, test-plan.md §8), measured per tenant from the database. */
export type Check = { key: string; label: string; value: number | null; target: string; ok: boolean | null };
export type TenantReport = { tenant_id: string; name: string; checks: Check[] };

const T = {
  cards: 300, tierAPrecision: 0.7, coverage: 0.6, agentCostUsd: 0.0024, contactCostUsd: 0.1, medianReviewS: 30,
} as const;

const ge = (v: number | null, min: number) => (v === null ? null : v >= min);
const le = (v: number | null, max: number) => (v === null ? null : v <= max);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Reads across tenants, so it needs the migrator/superuser connection (DATABASE_URL), never the app role.
 * `since` limits activity-based metrics (cards, decisions, costs) to a window; invariants are always all-time.
 */
export async function exitCriteriaReport(pool: Pool, opts: { since?: Date; tenantId?: string } = {}): Promise<TenantReport[]> {
  const since = opts.since ?? new Date(0);
  const { rows: tenants } = await pool.query<{ id: string; name: string }>(
    "SELECT id, name FROM abcrm.tenants WHERE status = 'active' AND ($1::uuid IS NULL OR id = $1) ORDER BY created_at", [opts.tenantId ?? null]);
  const out: TenantReport[] = [];
  for (const t of tenants) {
    const q = async <R extends Record<string, unknown>>(sql: string) => (await pool.query<R>(sql, [t.id, since])).rows[0]!;
    // G-Q cards and the outcome by scorecard tier.
    const cards = await q<{ cards: string; a_decided: string; a_approved: string; median_s: string | null; reviewed: string }>(`
      SELECT count(*) AS cards,
             count(*) FILTER (WHERE s.tier = 'A' AND d.status IN ('approved','edited','executed','rejected')) AS a_decided,
             count(*) FILTER (WHERE s.tier = 'A' AND d.status IN ('approved','edited','executed')) AS a_approved,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY d.review_ms / 1000.0) FILTER (WHERE d.review_ms IS NOT NULL) AS median_s,
             count(*) FILTER (WHERE d.review_ms IS NOT NULL) AS reviewed
      FROM abcrm.decisions d JOIN abcrm.scorecards s ON s.id = (d.action->'args'->>'scorecardId')::uuid
      WHERE d.tenant_id = $1 AND d.gate_id = 'G-Q' AND d.created_at >= $2`);
    // Quotes shown on cards must all be verified (ADR-013).
    const quotes = await q<{ unverified: string }>(`
      SELECT count(*) AS unverified
      FROM abcrm.decisions d
      JOIN abcrm.criterion_results cr ON cr.scorecard_id = (d.action->'args'->>'scorecardId')::uuid
      CROSS JOIN LATERAL jsonb_array_elements(cr.quotes) AS qt(v)
      WHERE d.tenant_id = $1 AND d.gate_id = 'G-Q' AND coalesce((qt.v->>'verified')::boolean, false) = false AND $2::timestamptz IS NOT NULL`);
    // Verified contact coverage on Tier A/B accounts.
    const coverage = await q<{ ab: string; covered: string }>(`
      SELECT count(DISTINCT s.account_id) AS ab,
             count(DISTINCT s.account_id) FILTER (WHERE EXISTS (SELECT 1 FROM abcrm.contacts c WHERE c.account_id = s.account_id
               AND c.status = 'active' AND c.email_verification->>'result' = 'valid')) AS covered
      FROM abcrm.scorecards s WHERE s.tenant_id = $1 AND s.tier IN ('A','B') AND s.created_at >= $2`);
    // Variable cost per credit (cost_ledger vs billable usage).
    const cost = await q<{ agent_micros: string; contact_micros: string; agent_credits: string; contact_credits: string }>(`
      SELECT (SELECT coalesce(sum(cost_usd_micros), 0) FROM abcrm.cost_ledger WHERE tenant_id = $1 AND occurred_at >= $2 AND kind IN ('llm','search','fetch')) AS agent_micros,
             (SELECT coalesce(sum(cost_usd_micros), 0) FROM abcrm.cost_ledger WHERE tenant_id = $1 AND occurred_at >= $2 AND kind IN ('contact_provider','email_verify')) AS contact_micros,
             (SELECT coalesce(sum(credits), 0) FROM abcrm.usage_events WHERE tenant_id = $1 AND occurred_at >= $2 AND meter = 'agent' AND billable) AS agent_credits,
             (SELECT coalesce(sum(credits), 0) FROM abcrm.usage_events WHERE tenant_id = $1 AND occurred_at >= $2 AND meter = 'contact' AND billable) AS contact_credits`);
    // INV-1: no approved email draft without an approved G-Q on the same card (all-time).
    const inv1 = await q<{ n: string }>(`
      SELECT count(*) AS n FROM abcrm.email_drafts e JOIN abcrm.decisions g ON g.id = e.decision_id
      WHERE e.tenant_id = $1 AND e.status IN ('approved','edited','queued','sent') AND $2::timestamptz IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM abcrm.decisions q WHERE q.card_id = g.card_id AND q.gate_id = 'G-Q' AND q.status IN ('approved','edited','executed'))`);
    // Metering reconciliation (test-plan.md §4): Σ usage_events = usage_balances.used per period and meter.
    const recon = await q<{ n: string }>(`
      SELECT count(*) AS n FROM abcrm.usage_balances b
      WHERE b.tenant_id = $1 AND $2::timestamptz IS NOT NULL AND b.used <> coalesce((SELECT sum(credits) FROM abcrm.usage_events u
        WHERE u.tenant_id = b.tenant_id AND u.meter = b.meter AND u.billable
          AND u.occurred_at >= b.period AND u.occurred_at < b.period + interval '1 month'), 0)`);

    const ratio = (a: unknown, b: unknown) => (Number(b) > 0 ? Number(a) / Number(b) : null);
    const per = (micros: unknown, credits: unknown) => (Number(credits) > 0 ? Number(micros) / 1e6 / Number(credits) : null);
    const tierA = ratio(cards.a_approved, cards.a_decided);
    const cov = ratio(coverage.covered, coverage.ab);
    const agentCost = per(cost.agent_micros, cost.agent_credits);
    const contactCost = per(cost.contact_micros, cost.contact_credits);
    const median = num(cards.median_s);
    out.push({ tenant_id: t.id, name: t.name, checks: [
      { key: "gq_cards", label: "G-Q cards", value: Number(cards.cards), target: `≥ ${T.cards}`, ok: Number(cards.cards) >= T.cards },
      { key: "tier_a_precision", label: "Tier A approved by reps", value: tierA, target: `≥ ${T.tierAPrecision}`, ok: ge(tierA, T.tierAPrecision) },
      { key: "unverified_quotes_on_cards", label: "Unverified quotes on cards", value: Number(quotes.unverified), target: "= 0", ok: Number(quotes.unverified) === 0 },
      { key: "contact_coverage_ab", label: "Tier A/B accounts with a verified contact", value: cov, target: `≥ ${T.coverage}`, ok: ge(cov, T.coverage) },
      { key: "cost_per_agent_credit_usd", label: "Variable cost per Agent Credit (USD)", value: agentCost, target: `≤ ${T.agentCostUsd}`, ok: le(agentCost, T.agentCostUsd) },
      { key: "cost_per_contact_credit_usd", label: "Variable cost per Contact Credit (USD)", value: contactCost, target: `≤ ${T.contactCostUsd}`, ok: le(contactCost, T.contactCostUsd) },
      { key: "inv1_violations", label: "Approved emails without an approved G-Q (INV-1)", value: Number(inv1.n), target: "= 0", ok: Number(inv1.n) === 0 },
      { key: "median_review_seconds", label: `Median review time per card (s, n=${cards.reviewed})`, value: median, target: `< ${T.medianReviewS}`, ok: median === null ? null : median < T.medianReviewS },
      { key: "metering_mismatches", label: "Usage balances not matching usage events", value: Number(recon.n), target: "= 0", ok: Number(recon.n) === 0 },
    ] });
  }
  return out;
}

export function formatReport(reports: TenantReport[]): string {
  const fmt = (v: number | null) => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(4));
  return reports.map((r) => [`${r.name} (${r.tenant_id})`,
    ...r.checks.map((c) => `  ${c.ok === null ? "…" : c.ok ? "✓" : "✗"} ${c.label.padEnd(52)} ${fmt(c.value).padStart(10)}  ${c.target}`)].join("\n")).join("\n\n");
}
