import { createHash } from "node:crypto";
import { withTenant, type Actor, type Pool, type TenantTx } from "@abcrm/db";
import { emit, notFound, Problem, recordUsage, releaseReservation, reserveCredits, uuidv7 } from "@abcrm/core";
import { ensureAgent, finishAgentRun, killSwitchOn, recordAgentStep, startAgentRun } from "@abcrm/agents";
import { recordLlmCost, sumUsage, type LlmGateway } from "@abcrm/llm";
import { evaluatePlaybook, scorecardCredits, sortCriteria, type AccountFacts, type EvalCriterion, type EvalOutput, type EvidenceItem, type Step } from "./evaluate.js";
import { selectPassages, type PageSource } from "./passages.js";
import { tierAtLeast } from "./scoring.js";
import type { Tier, TierThresholds } from "./types.js";

export type QualifyDeps = { pool: Pool; llm: LlmGateway | null; pages?: PageSource; step?: Step };
export type QualifyResult =
  | { status: "scored"; scorecardId: string; tier: Tier; cardEligible: boolean; existing: boolean }
  | { status: "skipped"; reason: string };

type PlaybookRow = { id: string; lineage_id: string; version: number; status: string; tier_thresholds: TierThresholds; card_min_tier: Tier; definition_hash: string };
type CriterionRow = { id: string; key: string; name: string; description: string; kind: EvalCriterion["kind"]; evaluation: EvalCriterion["evaluation"];
  rule: unknown; weight: number; evidence_required: boolean; unknown_policy: EvalCriterion["unknownPolicy"]; unknown_penalty: number; hints: string[]; order_no: number };
type AccountRow = { id: string; name: string; domain: string; hq_country: string | null; hq_state: string | null; employee_range: string | null;
  buyer_type: string | null; verticals: string[]; lead_types: string[]; flags: string[]; tech_signals: Record<string, unknown>; founded_year: number | null; status: string };

const system: Actor = { type: "system", id: "qualification" };
const direct: Step = (_n, fn) => fn();
const MAX_EVIDENCE = 30;

export const toCriterion = (r: CriterionRow): EvalCriterion & { id: string } => ({
  id: r.id, key: r.key, name: r.name, description: r.description, kind: r.kind, evaluation: r.evaluation, rule: r.rule ?? undefined, weight: r.weight,
  evidenceRequired: r.evidence_required, unknownPolicy: r.unknown_policy, unknownPenalty: r.unknown_penalty, hints: r.hints, orderNo: r.order_no,
});

export async function loadPlaybook(tx: TenantTx, playbookId: string) {
  const { rows: [pb] } = await tx.client.query<PlaybookRow>(
    "SELECT id, lineage_id, version, status, tier_thresholds, card_min_tier, definition_hash FROM abcrm.playbooks WHERE id = $1", [playbookId]);
  if (!pb) throw notFound("Playbook");
  const { rows } = await tx.client.query<CriterionRow>(
    `SELECT id, key, name, description, kind, evaluation, rule, weight, evidence_required, unknown_policy, unknown_penalty, hints, order_no
     FROM abcrm.criteria WHERE playbook_id = $1 ORDER BY order_no`, [playbookId]);
  return { playbook: pb, criteria: rows.map(toCriterion) };
}

export async function loadAccountFacts(tx: TenantTx, accountId: string) {
  const { rows: [a] } = await tx.client.query<AccountRow>(
    `SELECT id, name, domain, hq_country, hq_state, employee_range, buyer_type, verticals, lead_types, flags, tech_signals, founded_year, status
     FROM abcrm.accounts WHERE id = $1`, [accountId]);
  if (!a) throw notFound("Account");
  const { rows: contacts } = await tx.client.query<{ s: string | null }>(
    "SELECT email_verification->>'result' AS s FROM abcrm.contacts WHERE account_id = $1 AND status = 'active'", [accountId]);
  const account: AccountFacts = { name: a.name, domain: a.domain, hq_country: a.hq_country, hq_state: a.hq_state, employee_range: a.employee_range,
    buyer_type: a.buyer_type, verticals: a.verticals, lead_types: a.lead_types, flags: a.flags, tech_signals: a.tech_signals, founded_year: a.founded_year };
  return { account, contacts: { email_status: contacts.map((c) => c.s ?? "unknown") }, row: a };
}

export async function loadEvidence(tx: TenantTx, accountId: string): Promise<EvidenceItem[]> {
  const { rows } = await tx.client.query<EvidenceItem>(
    `SELECT id, kind, url, snippet FROM abcrm.evidence WHERE account_id = $1 AND NOT injection_flag ORDER BY created_at DESC LIMIT ${MAX_EVIDENCE}`, [accountId]);
  return rows;
}

/** Stable prompt layer [3]: what the tenant sells and to whom (IPP + active Supply Profile). */
export async function contextBlock(tx: TenantTx, ipp: { vertical: string; lead_types: string[]; buyer_types: string[]; purchase_formats: string[] } | null) {
  const { rows: [sp] } = await tx.client.query<{ verticals: string[]; lead_types: unknown; states: string[]; compliance_assets: unknown; positioning: string | null }>(
    "SELECT verticals, lead_types, states, compliance_assets, positioning FROM abcrm.supply_profiles WHERE status = 'active'");
  const lines = ["Context: the agency (our user) sells US data leads."];
  if (ipp) lines.push(`Target buyers: ${ipp.buyer_types.join(", ")} in ${ipp.vertical}, buying ${ipp.lead_types.join(", ")} as ${ipp.purchase_formats.join(", ")}.`);
  if (sp) lines.push(`Agency supply: ${JSON.stringify({ verticals: sp.verticals, lead_types: sp.lead_types, states: sp.states, compliance: sp.compliance_assets })}.`);
  return lines.join("\n");
}

async function saveEvidence(tx: TenantTx, accountId: string, passages: { url: string; pageId: string; text: string }[]) {
  for (const p of passages) {
    const hash = createHash("sha256").update(p.text).digest();
    const dup = await tx.client.query("SELECT 1 FROM abcrm.evidence WHERE account_id = $1 AND content_hash = $2", [accountId, hash]);
    if (dup.rowCount) continue;
    await tx.client.query(
      `INSERT INTO abcrm.evidence(id, tenant_id, account_id, kind, url, retrieved_at, snippet, content_hash, public_page_id)
       VALUES ($1, $2, $3, 'web_page', $4, now(), $5, $6, $7)`, [uuidv7(), tx.tenantId, accountId, p.url, p.text, hash, p.pageId]);
  }
}

function summaryText(s: EvalOutput["summary"]): string | null {
  if (!s) return null;
  return [`Why fit:`, ...s.whyFit.map((b) => `- ${b}`), ...(s.risks.length ? [`Risks:`, ...s.risks.map((b) => `- ${b}`)] : [])].join("\n");
}

/**
 * Q1 for one candidate (agents.md Q1): load → targeted fetch by hints → evaluate → persist scorecard.
 * Every external call and write is a named step; a retried run returns the existing scorecard.
 */
export async function qualifyCandidate(deps: QualifyDeps, tenantId: string, candidateId: string, opts: { eventId?: string; playbookId?: string } = {}): Promise<QualifyResult> {
  const step = deps.step ?? direct;
  const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(deps.pool, tenantId, system, fn);

  const ctx = await step("q1:load", () => inTenant(async (tx) => {
    const { rows: [cand] } = await tx.client.query<{ id: string; status: string; account_id: string; sourcing_run_id: string | null; scorecard_id: string | null }>(
      "SELECT id, status, account_id, sourcing_run_id, scorecard_id FROM abcrm.candidates WHERE id = $1 FOR UPDATE", [candidateId]);
    if (!cand) return { skip: "candidate_not_found" as const };
    if (await killSwitchOn(tx)) return { skip: "kill_switch" as const };
    const agent = await ensureAgent(tx, "Q1");
    if (agent.status !== "active") return { skip: "agent_paused" as const };

    // Playbook: the IPP's playbook (or the active version of its lineage), else an explicit/most recent active one.
    let ipp: { vertical: string; lead_types: string[]; buyer_types: string[]; purchase_formats: string[]; playbook_id: string } | null = null;
    if (cand.sourcing_run_id) {
      ipp = (await tx.client.query("SELECT i.vertical, i.lead_types, i.buyer_types, i.purchase_formats, i.playbook_id FROM abcrm.sourcing_runs r JOIN abcrm.ipps i ON i.id = r.ipp_id WHERE r.id = $1",
        [cand.sourcing_run_id])).rows[0] ?? null;
    }
    const wanted = opts.playbookId ?? ipp?.playbook_id ?? null;
    const { rows: [pb] } = await tx.client.query<{ id: string }>(
      wanted
        ? `SELECT p2.id FROM abcrm.playbooks p JOIN abcrm.playbooks p2 ON p2.lineage_id = p.lineage_id AND p2.status = 'active' WHERE p.id = $1 LIMIT 1`
        : "SELECT id FROM abcrm.playbooks WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1",
      wanted ? [wanted] : []);
    if (!pb) return { skip: "no_active_playbook" as const };

    const existing = await tx.client.query<{ id: string; tier: Tier }>("SELECT id, tier FROM abcrm.scorecards WHERE candidate_id = $1 AND playbook_id = $2", [candidateId, pb.id]);
    const { playbook, criteria } = await loadPlaybook(tx, pb.id);
    if (existing.rows[0]) {
      const e = existing.rows[0];
      return { done: { status: "scored" as const, scorecardId: e.id, tier: e.tier, cardEligible: tierAtLeast(e.tier, playbook.card_min_tier), existing: true } };
    }
    if (!["found", "qualifying", "scored"].includes(cand.status)) return { skip: `candidate_${cand.status}` as const };
    // Reserve the AI price; persist charges 1 or 4 and releases the reservation (pricing doc §4).
    if (!(await reserveCredits(tx, "agent", 4, `q1res:${candidateId}:${pb.id}`))) return { skip: "quota_exhausted" as const };
    await tx.client.query("UPDATE abcrm.candidates SET status = 'qualifying' WHERE id = $1", [candidateId]);
    const runId = await startAgentRun(tx, agent, { kind: opts.eventId ? "event" : "user", ...(opts.eventId ? { event_id: opts.eventId } : {}) }, { type: "candidate", id: candidateId });
    const { row } = await loadAccountFacts(tx, cand.account_id);
    return { cand, playbook, criteria, runId, agentId: agent.definitionId, domain: row.domain, context: await contextBlock(tx, ipp) };
  }));
  if ("skip" in ctx && ctx.skip) return { status: "skipped", reason: ctx.skip };
  if ("done" in ctx && ctx.done) return ctx.done;
  const { cand, playbook, criteria, runId, agentId, domain, context } = ctx as Exclude<typeof ctx, { skip: string } | { done: unknown }>;

  try {
    // Targeted fetch by hints (≤ 4 pages, public, cached globally) → verbatim passages as evidence.
    const hints = [...new Set(criteria.filter((c) => c.evaluation === "ai_judged").flatMap((c) => c.hints))];
    if (deps.pages && hints.length) {
      const pages = await step("q1:fetch", () => deps.pages!.pagesFor(domain, hints, 4));
      const passages = selectPassages(pages, criteria);
      if (passages.length) await step("q1:evidence", () => inTenant((tx) => saveEvidence(tx, cand.account_id, passages)));
    }

    const input = await step("q1:facts", () => inTenant(async (tx) => ({ ...(await loadAccountFacts(tx, cand.account_id)), evidence: await loadEvidence(tx, cand.account_id) })));
    const out = await evaluatePlaybook({
      criteria, thresholds: playbook.tier_thresholds, cardMinTier: playbook.card_min_tier, account: input.account, contacts: input.contacts,
      evidence: input.evidence, llm: deps.llm, contextBlock: context, step, stepPrefix: "q1",
    });

    return await step("q1:persist", () => inTenant(async (tx) => {
      const scorecardId = uuidv7();
      const credits = scorecardCredits(out.aiUsed);
      const ins = await tx.client.query(
        `INSERT INTO abcrm.scorecards(id, tenant_id, candidate_id, account_id, playbook_id, playbook_version, total_score, tier, stopped_at, summary, agent_run_id, agent_credits)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (tenant_id, candidate_id, playbook_id) DO NOTHING`,
        [scorecardId, tenantId, candidateId, cand.account_id, playbook.id, playbook.version, out.score.pct, out.score.tier, out.score.stoppedAt ?? null,
          summaryText(out.summary), runId, credits]);
      if (!ins.rowCount) {
        const { rows: [e] } = await tx.client.query<{ id: string; tier: Tier }>("SELECT id, tier FROM abcrm.scorecards WHERE candidate_id = $1 AND playbook_id = $2", [candidateId, playbook.id]);
        return { status: "scored" as const, scorecardId: e!.id, tier: e!.tier, cardEligible: tierAtLeast(e!.tier, playbook.card_min_tier), existing: true };
      }
      const byKey = new Map(criteria.map((c) => [c.key, c]));
      for (const r of out.results) {
        const c = byKey.get(r.key)!;
        await tx.client.query(
          `INSERT INTO abcrm.criterion_results(id, tenant_id, scorecard_id, criterion_id, result, confidence, rationale, evidence_ids, quotes, points)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [uuidv7(), tenantId, scorecardId, c.id, r.result, r.confidence, r.rationale, [...new Set(r.quotes.map((q) => q.evidenceId))],
            JSON.stringify(r.quotes.map((q) => ({ evidence_id: q.evidenceId, text: q.text, verified: true }))), out.score.perCriterion[r.key]?.points ?? 0]);
      }
      await tx.client.query("UPDATE abcrm.candidates SET status = 'scored', scorecard_id = $2 WHERE id = $1", [candidateId, scorecardId]);
      const meterKey = `q1:${candidateId}:${playbook.id}`;
      await releaseReservation(tx, `q1res:${candidateId}:${playbook.id}`);
      await recordUsage(tx, { idempotencyKey: meterKey, meter: "agent", actionType: out.aiUsed ? "scorecard_ai" : "scorecard_rule_only", credits,
        agentDefinitionId: agentId, agentRunId: runId, sourcingRunId: cand.sourcing_run_id });
      let seq = 0;
      for (const u of out.usages) {
        await recordLlmCost(tx, u.usage, { agentRunId: runId, meterLink: meterKey });
        await recordAgentStep(tx, runId, { seq: seq++, kind: "llm_call", name: `${u.purpose}:${u.usage.model}`,
          tokens: { input: u.usage.inputTokens, output: u.usage.outputTokens, cache_read: u.usage.cacheReadTokens, cache_write: u.usage.cacheWriteTokens } });
      }
      const tot = sumUsage(out.usages.map((u) => u.usage));
      await finishAgentRun(tx, runId, "completed", { tokens: { input: tot.input, output: tot.output, cache_read: tot.cache_read, cache_write: tot.cache_write },
        costUsdMicros: tot.cost_usd_micros, agentCredits: credits });
      if (cand.sourcing_run_id) {
        await tx.client.query(
          `UPDATE abcrm.sourcing_runs SET stats = stats || jsonb_build_object('qualified', coalesce((stats->>'qualified')::int, 0) + 1,
             'agent_credits_used', coalesce((stats->>'agent_credits_used')::numeric, 0) + $2) WHERE id = $1`, [cand.sourcing_run_id, credits]);
      }
      const cardEligible = tierAtLeast(out.score.tier, playbook.card_min_tier);
      await emit(tx, "qualification.scorecard.created", {
        scorecard_id: scorecardId, candidate_id: candidateId, account_id: cand.account_id, tier: out.score.tier, stopped_at: out.score.stoppedAt ?? null,
        card_eligible: cardEligible, injection_suspected: out.injectionSuspected, unverified_quotes: out.unverifiedQuotes, total_quotes: out.totalQuotes,
      }, { correlationId: cand.sourcing_run_id ?? undefined });
      return { status: "scored" as const, scorecardId, tier: out.score.tier, cardEligible, existing: false };
    }));
  } catch (e) {
    await inTenant(async (tx) => {
      await tx.client.query("UPDATE abcrm.candidates SET status = 'failed' WHERE id = $1 AND status = 'qualifying'", [candidateId]);
      await releaseReservation(tx, `q1res:${candidateId}:${playbook.id}`);
      await finishAgentRun(tx, runId, "failed", {}, (e as Error).message);
    });
    throw e;
  }
}

export async function getScorecard(tx: TenantTx, id: string) {
  const { rows: [s] } = await tx.client.query(
    `SELECT id, candidate_id, account_id, playbook_id, playbook_version, total_score, tier, stopped_at, summary, agent_credits, created_at
     FROM abcrm.scorecards WHERE id = $1`, [id]);
  if (!s) throw notFound("Scorecard");
  const { rows: criteria } = await tx.client.query(
    `SELECT c.key, c.name, c.kind, c.evaluation, r.result, r.confidence, r.rationale, r.quotes, r.points
     FROM abcrm.criterion_results r JOIN abcrm.criteria c ON c.id = r.criterion_id WHERE r.scorecard_id = $1 ORDER BY c.order_no`, [id]);
  return { ...s, criteria };
}

export async function listAccountScorecards(tx: TenantTx, accountId: string) {
  const { rowCount } = await tx.client.query("SELECT 1 FROM abcrm.accounts WHERE id = $1", [accountId]);
  if (!rowCount) throw notFound("Account");
  const { rows } = await tx.client.query(
    `SELECT id, candidate_id, playbook_id, playbook_version, total_score, tier, stopped_at, summary, created_at
     FROM abcrm.scorecards WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`, [accountId]);
  return rows;
}

/** POST /candidates/manual: an account typed in by a rep goes straight to qualification. */
export async function createManualCandidate(tx: TenantTx, actor: Actor, accountId: string, note?: string): Promise<{ candidateId: string }> {
  const { rows: [a] } = await tx.client.query<{ id: string; flags: string[] }>("SELECT id, flags FROM abcrm.accounts WHERE id = $1", [accountId]);
  if (!a) throw notFound("Account");
  if (a.flags.includes("do_not_contact")) throw new Problem("conflict", "Account is flagged do_not_contact");
  const id = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.candidates(id, tenant_id, sourcing_run_id, account_id, discovered_via, status) VALUES ($1, $2, NULL, $3, $4, 'found')`,
    [id, tx.tenantId, accountId, { kind: "manual", note: note?.slice(0, 500) ?? null, by: actor.id }]);
  await emit(tx, "sourcing.candidate.ready", { candidate_id: id, account_id: accountId });
  return { candidateId: id };
}

export { sortCriteria };
