import type { Actor, TenantTx } from "@abcrm/db";
import { appendAudit, emit, notFound, Problem, uuidv7 } from "@abcrm/core";
import { proposeDecision } from "@abcrm/agents";
import { CREDITS } from "./candidates.js";

export const APPROVAL_THRESHOLD = { targetCount: 500, agentCredits: 5_000 };

/** Rough pre-run estimate (pricing §5). Contact credits apply once contact lookup runs (M4). */
export function estimateRun(targetCount: number) {
  const agent = targetCount * CREDITS.candidate_sourced;
  const contact = Math.ceil(targetCount * 0.3 * 2);   // ~30% reach a card, ~2 verified contacts each
  return { agent_credits: agent, contact_credits: contact, requires_approval: targetCount > APPROVAL_THRESHOLD.targetCount || agent > APPROVAL_THRESHOLD.agentCredits };
}

const COLS = `id, ipp_id, target_count, agent_credit_budget, contact_credit_budget, status, plan, stats, approved_decision_id, started_by,
  started_at, finished_at, created_at, updated_at`;

export async function createRun(tx: TenantTx, actor: Actor, input: { ippId: string; targetCount: number; agentCreditBudget: number; contactCreditBudget: number }) {
  const { rows: [ipp] } = await tx.client.query<{ status: string }>("SELECT status FROM abcrm.ipps WHERE id = $1", [input.ippId]);
  if (!ipp) throw notFound("IPP");
  if (ipp.status !== "active") throw new Problem("conflict", "Sourcing runs need an active IPP");
  const est = estimateRun(input.targetCount);
  const needsApproval = est.requires_approval || input.agentCreditBudget > APPROVAL_THRESHOLD.agentCredits;
  const id = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.sourcing_runs(id, tenant_id, ipp_id, target_count, agent_credit_budget, contact_credit_budget, status, started_by, stats)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, tx.tenantId, input.ippId, input.targetCount, input.agentCreditBudget, input.contactCreditBudget, needsApproval ? "pending_approval" : "queued",
      actor.type === "user" ? actor.id : null, { found: 0, deduped: 0, skipped: 0, agent_credits_used: 0, queries_run: 0, domains_examined: 0 }]);
  let decisionId: string | null = null;
  if (needsApproval) {
    decisionId = await proposeDecision(tx, {
      gate: "G-T1", lane: "setup", subject: { type: "sourcing_run", id },
      action: { tool: "sourcing_run.start", args: { id, target_count: input.targetCount, agent_credit_budget: input.agentCreditBudget } },
      proposedBy: actor.type === "user" ? { type: "user", userId: actor.id } : { type: "agent", agentRunId: actor.id },
      explanation: `Start sourcing run: ${input.targetCount} candidates, budget ${input.agentCreditBudget} agent credits`,
    });
  } else {
    await emit(tx, "sourcing.run.queued", { sourcing_run_id: id });
  }
  await appendAudit(tx, { actor, action: "sourcing_run.created", subject: { type: "sourcing_run", id } });
  return { ...(await getRun(tx, id)), decision_id: decisionId };
}

export async function getRun(tx: TenantTx, id: string) {
  const { rows: [r] } = await tx.client.query(`SELECT ${COLS} FROM abcrm.sourcing_runs WHERE id = $1`, [id]);
  if (!r) throw notFound("Sourcing run");
  return r;
}

export async function listRuns(tx: TenantTx) {
  const { rows } = await tx.client.query(`SELECT ${COLS} FROM abcrm.sourcing_runs ORDER BY created_at DESC LIMIT 100`);
  return rows;
}

/** Executor for an approved G-T1 on a sourcing run. */
export async function startApprovedRun(tx: TenantTx, id: string, decisionId: string) {
  const res = await tx.client.query(
    "UPDATE abcrm.sourcing_runs SET status = 'queued', approved_decision_id = $2 WHERE id = $1 AND status = 'pending_approval'", [id, decisionId]);
  if (res.rowCount !== 1) throw new Problem("conflict", "Sourcing run is not awaiting approval");
  await emit(tx, "sourcing.run.queued", { sourcing_run_id: id });
}

export async function cancelRejectedRun(tx: TenantTx, id: string) {
  await tx.client.query("UPDATE abcrm.sourcing_runs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'pending_approval'", [id]);
}

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  pause: { from: ["queued", "running"], to: "paused" },
  resume: { from: ["paused"], to: "queued" },
  cancel: { from: ["pending_approval", "queued", "running", "paused"], to: "cancelled" },
};

export async function controlRun(tx: TenantTx, actor: Actor, id: string, op: keyof typeof TRANSITIONS) {
  const t = TRANSITIONS[op]!;
  const { rows: [r] } = await tx.client.query<{ status: string }>(
    `UPDATE abcrm.sourcing_runs SET status = $3, finished_at = CASE WHEN $3 = 'cancelled' THEN now() ELSE finished_at END
     WHERE id = $1 AND status = ANY($2) RETURNING status`, [id, t.from, t.to]);
  if (!r) { await getRun(tx, id); throw new Problem("conflict", `Cannot ${op} this run`); }
  if (op === "resume") await emit(tx, "sourcing.run.queued", { sourcing_run_id: id });
  await appendAudit(tx, { actor, action: `sourcing_run.${op}`, subject: { type: "sourcing_run", id } });
  return getRun(tx, id);
}

export async function listCandidates(tx: TenantTx, runId: string, opts: { status?: string; limit: number }) {
  await getRun(tx, runId);
  const { rows } = await tx.client.query(
    `SELECT c.id, c.status, c.dedupe_reason, c.discovered_via, c.created_at, a.id AS account_id, a.name, a.domain, a.tech_signals, a.lead_types,
            (SELECT count(*)::int FROM abcrm.evidence e WHERE e.account_id = a.id) AS evidence_count
     FROM abcrm.candidates c JOIN abcrm.accounts a ON a.id = c.account_id
     WHERE c.sourcing_run_id = $1 AND ($2::text IS NULL OR c.status = $2) ORDER BY c.created_at LIMIT $3`,
    [runId, opts.status ?? null, opts.limit]);
  return rows;
}

export async function listEvidence(tx: TenantTx, accountId: string) {
  const { rows } = await tx.client.query(
    "SELECT id, kind, url, retrieved_at, snippet, injection_flag FROM abcrm.evidence WHERE account_id = $1 ORDER BY retrieved_at", [accountId]);
  return rows;
}
