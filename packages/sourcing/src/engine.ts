import { withTenant, type Actor, type Pool, type TenantTx } from "@abcrm/db";
import { emit, releaseReservation, reserveCredits, type TenantKeyring } from "@abcrm/core";
import { ensureAgent } from "@abcrm/agents";
import { recordLlmCost, type LlmGateway, type LlmUsage } from "@abcrm/llm";
import { loadPack } from "@abcrm/setup";
import { recordCandidate } from "./candidates.js";
import { examineDomain, type Findings } from "./examine.js";
import { extractFindings, mergeFindings } from "./extractor.js";
import type { Fetcher } from "./fetcher.js";
import { planQueries } from "./plan.js";
import type { SearchProvider } from "./search.js";
import { registrableDomain } from "./url.js";

/** Durable step wrapper: DBOS.runStep in the worker, direct call in tests. */
export type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
const direct: Step = (_name, fn) => fn();

/** Sites that are never lead buyers themselves (directories, social, job boards, encyclopedias). */
export const SKIP_DOMAINS = new Set([
  "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "tiktok.com", "reddit.com", "wikipedia.org",
  "indeed.com", "glassdoor.com", "ziprecruiter.com", "monster.com", "simplyhired.com", "google.com", "amazon.com", "crunchbase.com",
  "bbb.org", "yelp.com", "github.com", "medium.com", "quora.com", "pinterest.com", "apple.com", "microsoft.com",
]);

export type EngineDeps = {
  pool: Pool; keyring: TenantKeyring; fetcher: Fetcher; search: SearchProvider; step?: Step; siteUrl?: (domain: string) => string;
  /** S1 extractor; without it the rule-based examine decides alone. */
  llm?: LlmGateway | null;
};
export type RunStats = { found: number; deduped: number; skipped: number; agent_credits_used: number; queries_run: number; domains_examined: number };
type Ipp = { id: string; vertical: string; lead_types: string[]; signals: { web_paths: string[]; text: string[] }; exclusions: { domains: string[]; keywords: string[] } };

const actor: Actor = { type: "system", id: "sourcing-engine" };

async function bumpStats(tx: TenantTx, runId: string, delta: Partial<RunStats>): Promise<RunStats> {
  const { rows: [r] } = await tx.client.query<{ stats: RunStats }>("SELECT stats FROM abcrm.sourcing_runs WHERE id = $1 FOR UPDATE", [runId]);
  const stats = { ...r!.stats };
  for (const [k, v] of Object.entries(delta)) stats[k as keyof RunStats] = (stats[k as keyof RunStats] ?? 0) + (v ?? 0);
  await tx.client.query("UPDATE abcrm.sourcing_runs SET stats = $2 WHERE id = $1", [runId, stats]);
  return stats;
}

/**
 * Runs (or resumes) one sourcing run until the target, the budget, a pause/cancel, or the end of the plan.
 * Every external call and every write is a named step, so a restarted worker replays checkpoints instead of
 * re-searching, re-fetching or double-charging.
 */
export async function runSourcing(deps: EngineDeps, tenantId: string, runId: string): Promise<{ status: string; stats: RunStats }> {
  const step = deps.step ?? direct;
  const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(deps.pool, tenantId, actor, fn);

  const start = await step("load", () => inTenant(async (tx) => {
    const { rows: [run] } = await tx.client.query<{ status: string; ipp_id: string; target_count: number; agent_credit_budget: number; stats: RunStats; plan: { queries: string[] } | null }>(
      "SELECT status, ipp_id, target_count, agent_credit_budget, stats, plan FROM abcrm.sourcing_runs WHERE id = $1 FOR UPDATE", [runId]);
    if (!run || !["queued", "running"].includes(run.status)) return null;
    const { rows: [ipp] } = await tx.client.query<Ipp>("SELECT id, vertical, lead_types, signals, exclusions FROM abcrm.ipps WHERE id = $1", [run.ipp_id]);
    // A paused S1 agent (manual, budget, anomaly) pauses its runs instead of spending.
    const agent = await ensureAgent(tx, "S1");
    if (agent.status !== "active") {
      await tx.client.query(`UPDATE abcrm.sourcing_runs SET status = 'paused', stats = stats || jsonb_build_object('paused_reason', 'agent_paused') WHERE id = $1`, [runId]);
      return null;
    }
    await tx.client.query("UPDATE abcrm.sourcing_runs SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = $1", [runId]);
    const seen = (await tx.client.query<{ domain: string }>(
      "SELECT a.domain FROM abcrm.candidates c JOIN abcrm.accounts a ON a.id = c.account_id WHERE c.sourcing_run_id = $1", [runId])).rows.map((r) => r.domain);
    return { run, ipp: ipp!, seen, agentId: agent.definitionId };
  }));
  if (!start) {
    return inTenant(async (tx) => {
      const { rows: [run] } = await tx.client.query<{ status: string; stats: RunStats }>("SELECT status, stats FROM abcrm.sourcing_runs WHERE id = $1", [runId]);
      return { status: run?.status ?? "missing", stats: run?.stats ?? ({} as RunStats) };
    });
  }
  const { run, ipp, agentId } = start;
  const seen = new Set(start.seen);

  const pack = await loadPack(ipp.vertical).catch(() => null);
  if (!pack) return finish("failed", run.stats, `no vertical pack for ${ipp.vertical}`);
  const queries = run.plan?.queries ?? planQueries(ipp, pack);
  if (!run.plan) await step("plan", () => inTenant((tx) => tx.client.query("UPDATE abcrm.sourcing_runs SET plan = $2 WHERE id = $1", [runId, { queries }])));
  const labels = Object.fromEntries(pack.taxonomy.lead_types.filter((l) => ipp.lead_types.includes(l.key)).map((l) => [l.key, l.label]));

  let stats = run.stats;
  for (let qi = stats.queries_run; qi < queries.length; qi++) {
    const query = queries[qi]!;
    const results = await step(`search:${qi}`, () => deps.search.search({ query, limit: 10 }));
    const domains: string[] = [];
    for (const r of results) {
      let d: string;
      try { d = registrableDomain(new URL(r.url)); } catch { continue; }
      if (SKIP_DOMAINS.has(d) || ipp.exclusions.domains.includes(d) || seen.has(d) || domains.includes(d)) continue;
      domains.push(d);
    }

    for (const domain of domains) {
      if (stats.found >= run.target_count) return finish("completed", stats);
      if (stats.agent_credits_used + 2 > run.agent_credit_budget) return finish("budget_exhausted", stats);
      const ctl = await step(`ctl:${qi}:${domain}`, () => inTenant(async (tx) => {
        const status = (await tx.client.query<{ status: string }>("SELECT status FROM abcrm.sourcing_runs WHERE id = $1", [runId])).rows[0]!.status;
        // Reserve the candidate price before fetching; the record step charges it (found) or releases it.
        return { status, credits: status === "running" ? await reserveCredits(tx, "agent", 2, `srunres:${runId}:${domain}`) : false };
      }));
      if (ctl.status !== "running") return { status: ctl.status, stats };
      if (!ctl.credits) return finish("budget_exhausted", stats, "tenant agent credits exhausted");

      seen.add(domain);
      let findings: Findings = await step(`examine:${domain}`, () => examineDomain(deps.fetcher, {
        domain, webPaths: ipp.signals.web_paths, positive: ipp.signals.text, negative: ipp.exclusions.keywords, leadTypeLabels: labels, siteUrl: deps.siteUrl }));
      let s1Usage: LlmUsage | null = null;
      if (deps.llm && findings.reachable) {
        const llm = deps.llm;
        const before = findings;
        const ext = await step(`extract:${domain}`, () => extractFindings(llm, before, { vertical: ipp.vertical, leadTypeLabels: labels }));
        s1Usage = ext.usage;
        findings = mergeFindings(findings, ext.output, Object.keys(labels));
      }
      const final = findings;

      stats = await step(`record:${domain}`, () => inTenant(async (tx) => {
        // Internal cost is tracked even when the domain is skipped (no credit is charged then).
        if (s1Usage) await recordLlmCost(tx, s1Usage, { meterLink: `srun:${runId}:dom:${domain}` });
        await releaseReservation(tx, `srunres:${runId}:${domain}`);
        const findings = final;
        if (!findings.reachable || !findings.isLeadBuyerLikely || findings.isCompetitorLikely) {
          return bumpStats(tx, runId, { skipped: 1, domains_examined: 1 });
        }
        const rec = await recordCandidate(tx, deps.keyring, actor, runId, findings, { vertical: ipp.vertical, excludedDomains: ipp.exclusions.domains, query, agentDefinitionId: agentId });
        if (rec.status === "duplicate_in_run") return bumpStats(tx, runId, {});
        const s = await bumpStats(tx, runId, { domains_examined: 1, agent_credits_used: rec.credits, ...(rec.status === "found" ? { found: 1 } : { deduped: 1 }) });
        if (rec.status === "found") await emit(tx, "sourcing.candidate.ready", { candidate_id: rec.candidateId, account_id: rec.accountId }, { correlationId: runId });
        return s;
      }));
    }
    stats = await step(`query-done:${qi}`, () => inTenant((tx) => bumpStats(tx, runId, { queries_run: 1 })));
    if (stats.found >= run.target_count) return finish("completed", stats);
  }
  return finish("completed", stats);

  async function finish(status: "completed" | "budget_exhausted" | "failed", s: RunStats, reason?: string) {
    await step(`finish:${status}`, () => inTenant(async (tx) => {
      await tx.client.query(
        `UPDATE abcrm.sourcing_runs SET status = $2, finished_at = now(), stats = stats || $3 WHERE id = $1 AND status = 'running'`,
        [runId, status, reason ? { error: reason } : {}]);
      await emit(tx, status === "budget_exhausted" ? "sourcing.run.budget_exhausted" : "sourcing.run.completed",
        { sourcing_run_id: runId, stats: s, ...(reason ? { error: reason } : {}) });
    }));
    return { status, stats: s };
  }
}
