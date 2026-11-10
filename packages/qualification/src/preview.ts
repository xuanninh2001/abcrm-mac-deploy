import { withTenant, type Actor, type Pool, type TenantTx } from "@abcrm/db";
import { emit, notFound, Problem, recordUsage, releaseReservation, reserveCredits, uuidv7 } from "@abcrm/core";
import { recordLlmCost, type LlmGateway } from "@abcrm/llm";
import { contextBlock, loadAccountFacts, loadEvidence, loadPlaybook } from "./engine.js";
import { evaluatePlaybook, scorecardCredits, type Step } from "./evaluate.js";
import type { Tier } from "./types.js";

export const PREVIEW_MAX = 20;
const system: Actor = { type: "system", id: "qualification-preview" };

/** POST /playbooks/{id}/preview: records the request; the worker runs it (LLM calls are too slow for a request). */
export async function requestPreview(tx: TenantTx, actor: Actor, playbookId: string, opts: { sample: "recent" | "golden"; size: number }) {
  const { playbook } = await loadPlaybook(tx, playbookId);
  if (opts.sample === "golden") throw new Problem("validation-failed", "Golden samples are not available yet; use sample=recent");
  const size = Math.min(Math.max(opts.size, 1), PREVIEW_MAX);
  const id = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.playbook_previews(id, tenant_id, playbook_id, definition_hash, sample, sample_size, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, tx.tenantId, playbookId, playbook.definition_hash, opts.sample, size, actor.type === "user" ? actor.id : null]);
  await emit(tx, "playbook.preview.requested", { preview_id: id, playbook_id: playbookId });
  return getPreview(tx, id);
}

export async function getPreview(tx: TenantTx, id: string) {
  const { rows: [p] } = await tx.client.query(
    `SELECT id, playbook_id, definition_hash, sample, sample_size, status, tier_distribution, results, error, agent_credits, created_at, finished_at
     FROM abcrm.playbook_previews WHERE id = $1`, [id]);
  if (!p) throw notFound("Preview");
  return p;
}

export async function listPreviews(tx: TenantTx, playbookId: string) {
  const { rows } = await tx.client.query(
    `SELECT id, sample, sample_size, status, tier_distribution, agent_credits, created_at, finished_at FROM abcrm.playbook_previews
     WHERE playbook_id = $1 ORDER BY created_at DESC LIMIT 20`, [playbookId]);
  return rows;
}

/**
 * Runs a preview: the playbook (any status, usually a draft) against the tenant's most recent accounts that
 * have evidence. Nothing is written to scorecards; the per-account results stay on the preview row.
 * Charged like scorecards (pricing doc §1.1).
 */
export async function runPreview(deps: { pool: Pool; llm: LlmGateway | null; step?: Step }, tenantId: string, previewId: string) {
  const step: Step = deps.step ?? ((_n, fn) => fn());
  const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(deps.pool, tenantId, system, fn);
  const ctx = await step("pv:load", () => inTenant(async (tx) => {
    const pv = await getPreview(tx, previewId);
    if (pv.status !== "running") return null;
    const { playbook, criteria } = await loadPlaybook(tx, pv.playbook_id);
    const { rows: sample } = await tx.client.query<{ id: string }>(
      `SELECT a.id FROM abcrm.accounts a JOIN LATERAL (SELECT max(e.created_at) AS last FROM abcrm.evidence e WHERE e.account_id = a.id) e ON e.last IS NOT NULL
       ORDER BY e.last DESC LIMIT $1`, [pv.sample_size]);
    const ipp = (await tx.client.query("SELECT vertical, lead_types, buyer_types, purchase_formats FROM abcrm.ipps WHERE playbook_id = $1 LIMIT 1", [playbook.id])).rows[0] ?? null;
    return { playbook, criteria, accountIds: sample.map((s) => s.id), context: await contextBlock(tx, ipp) };
  }));
  if (!ctx) return;

  try {
    const results: unknown[] = [];
    const dist: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0 };
    let credits = 0;
    for (const accountId of ctx.accountIds) {
      if (!(await step(`pv:credits:${accountId}`, () => inTenant((tx) => reserveCredits(tx, "agent", 4, `pvres:${previewId}:${accountId}`))))) {
        throw new Problem("quota-exhausted", "Agent credits exhausted", { meter: "agent" });
      }
      const input = await step(`pv:facts:${accountId}`, () => inTenant(async (tx) => ({ ...(await loadAccountFacts(tx, accountId)), evidence: await loadEvidence(tx, accountId) })));
      const out = await evaluatePlaybook({
        criteria: ctx.criteria, thresholds: ctx.playbook.tier_thresholds, cardMinTier: ctx.playbook.card_min_tier, account: input.account,
        contacts: input.contacts, evidence: input.evidence, llm: deps.llm, contextBlock: ctx.context, step, stepPrefix: `pv:${accountId}`,
      });
      dist[out.score.tier]++;
      const c = scorecardCredits(out.aiUsed);
      credits += c;
      results.push({
        account_id: accountId, domain: input.account.domain, name: input.account.name, tier: out.score.tier, pct: out.score.pct,
        stopped_at: out.score.stoppedAt ?? null, caps: out.score.caps, unverified_quotes: out.unverifiedQuotes,
        criteria: Object.fromEntries(out.results.map((r) => [r.key, { result: r.result, rationale: r.rationale, quotes: r.quotes.map((q) => ({ evidence_id: q.evidenceId, text: q.text })) }])),
      });
      await step(`pv:meter:${accountId}`, () => inTenant(async (tx) => {
        const key = `pbprev:${previewId}:${accountId}`;
        await releaseReservation(tx, `pvres:${previewId}:${accountId}`);
        await recordUsage(tx, { idempotencyKey: key, meter: "agent", actionType: out.aiUsed ? "scorecard_ai" : "scorecard_rule_only", credits: c });
        for (const u of out.usages) await recordLlmCost(tx, u.usage, { meterLink: key });
      }));
    }
    await step("pv:finish", () => inTenant(async (tx) => {
      await tx.client.query(
        `UPDATE abcrm.playbook_previews SET status = 'completed', tier_distribution = $2, results = $3, agent_credits = $4, finished_at = now()
         WHERE id = $1 AND status = 'running'`, [previewId, dist, JSON.stringify(results), credits]);
      await emit(tx, "playbook.preview.completed", { preview_id: previewId, playbook_id: ctx.playbook.id, sample_size: ctx.accountIds.length, tier_distribution: dist });
    }));
  } catch (e) {
    await inTenant((tx) => tx.client.query(
      "UPDATE abcrm.playbook_previews SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'running'", [previewId, (e as Error).message.slice(0, 500)]));
    throw e;
  }
}
