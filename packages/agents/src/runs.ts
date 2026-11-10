import type { TenantTx } from "@abcrm/db";
import { emit, notFound, pauseAgent, uuidv7 } from "@abcrm/core";
import { PERSONA_PERMISSIONS } from "./permissions.js";

export type TemplateKey = "S1" | "S2" | "Q1" | "W1" | "I1";
const TEMPLATE_PERSONA: Record<TemplateKey, string> = { S1: "sourcing", S2: "qualification", Q1: "qualification", W1: "qualification", I1: "sourcing" };
const TEMPLATE_NAME: Record<TemplateKey, string> = {
  S1: "Lead Sourcing", S2: "Contact Finder", Q1: "Qualification", W1: "Outreach Writer", I1: "Import Mapper",
};

export type AgentRef = { definitionId: string; version: number; personaId: string; personaKey: string; status: string };

/** Persona row for a key (ADR-003); created with the platform permission set on first use. */
export async function ensurePersona(tx: TenantTx, key: string): Promise<string> {
  const perms = [...(PERSONA_PERMISSIONS[key] ?? [])];
  const { rows: [p] } = await tx.client.query<{ id: string }>(
    `INSERT INTO abcrm.service_personas(id, tenant_id, key, permissions) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, key) DO UPDATE SET key = EXCLUDED.key RETURNING id`, [uuidv7(), tx.tenantId, key, perms]);
  return p!.id;
}

/**
 * The tenant's default agent for a template (Phase 1: one per template, created on first use; tenant-defined
 * agents arrive with the agents API). Paused or archived agents are returned as-is so callers can refuse to run.
 */
export async function ensureAgent(tx: TenantTx, template: TemplateKey): Promise<AgentRef> {
  const personaKey = TEMPLATE_PERSONA[template];
  const existing = await tx.client.query<{ id: string; version: number; status: string; run_as: { id: string } }>(
    `SELECT id, version, status, run_as FROM abcrm.agent_definitions WHERE template_key = $1 AND status <> 'archived'
     ORDER BY created_at, version DESC LIMIT 1`, [template]);
  if (existing.rows[0]) {
    const r = existing.rows[0];
    return { definitionId: r.id, version: r.version, personaId: r.run_as.id, personaKey, status: r.status };
  }
  // Serialize creation per tenant+template so concurrent first runs do not create two agents.
  await tx.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent:${tx.tenantId}:${template}`]);
  const again = await tx.client.query<{ id: string; version: number; status: string; run_as: { id: string } }>(
    "SELECT id, version, status, run_as FROM abcrm.agent_definitions WHERE template_key = $1 AND status <> 'archived' LIMIT 1", [template]);
  if (again.rows[0]) {
    const r = again.rows[0];
    return { definitionId: r.id, version: r.version, personaId: r.run_as.id, personaKey, status: r.status };
  }
  const personaId = await ensurePersona(tx, personaKey);
  const id = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.agent_definitions(id, tenant_id, lineage_id, template_key, template_version, name, version, config, run_as, status)
     VALUES ($1, $2, $1, $3, 1, $4, 1, '{}', $5, 'active')`, [id, tx.tenantId, template, TEMPLATE_NAME[template], { type: "persona", id: personaId }]);
  return { definitionId: id, version: 1, personaId, personaKey, status: "active" };
}

/** Kill switch (FR-A10): checked before each agent step. */
export async function killSwitchOn(tx: TenantTx): Promise<boolean> {
  const { rows: [t] } = await tx.client.query<{ kill_switch: boolean; status: string }>("SELECT kill_switch, status FROM abcrm.tenants WHERE id = $1", [tx.tenantId]);
  return !t || t.kill_switch || t.status !== "active";
}

export async function startAgentRun(
  tx: TenantTx, agent: AgentRef, trigger: { kind: "event" | "schedule" | "user"; event_id?: string }, subject: { type: string; id: string }, id = uuidv7(),
): Promise<string> {
  await tx.client.query(
    `INSERT INTO abcrm.agent_runs(id, tenant_id, agent_definition_id, agent_version, trigger, subject, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', now()) ON CONFLICT (id) DO NOTHING`,
    [id, tx.tenantId, agent.definitionId, agent.version, trigger, subject]);
  return id;
}

export type RunTotals = { tokens?: Record<string, number>; costUsdMicros?: number; agentCredits?: number };

export async function finishAgentRun(tx: TenantTx, runId: string, status: "completed" | "failed" | "cancelled", totals: RunTotals = {}, error?: string) {
  await tx.client.query(
    `UPDATE abcrm.agent_runs SET status = $2, finished_at = now(), tokens = $3, cost_usd_micros = $4, agent_credits = $5, error = $6
     WHERE id = $1 AND status = 'running'`,
    [runId, status, totals.tokens ?? {}, totals.costUsdMicros ?? 0, totals.agentCredits ?? 0, error ? { message: error.slice(0, 500) } : null]);
}

/** One row per LLM call / tool call (agents.md §0 trace). Payloads stay out of the row (refs only). */
export async function recordAgentStep(
  tx: TenantTx, runId: string, step: { seq: number; kind: "llm_call" | "tool_call" | "policy_eval"; name: string; latencyMs?: number; tokens?: Record<string, number>; decision?: string },
): Promise<void> {
  await tx.client.query(
    `INSERT INTO abcrm.agent_steps(id, tenant_id, run_id, seq, kind, name, decision, latency_ms, tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [uuidv7(), tx.tenantId, runId, step.seq, step.kind, step.name, step.decision ?? null, step.latencyMs ?? null, step.tokens ?? null]);
}

/** Quality circuit breaker (pricing doc §3.1): < 20% approvals over the last ≥ 50 decided G-Q proposals pauses the agent. */
export async function evaluateQualityBreaker(tx: TenantTx, agentDefinitionId: string, minDecided = 50, minRate = 0.2): Promise<boolean> {
  const { rows: [r] } = await tx.client.query<{ n: number; ok: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE status IN ('approved', 'edited', 'executed'))::int AS ok FROM (
       SELECT d.status FROM abcrm.decisions d JOIN abcrm.agent_runs r ON r.id = (d.proposed_by->>'agentRunId')::uuid
       WHERE d.gate_id = 'G-Q' AND r.agent_definition_id = $1 AND d.status IN ('approved', 'edited', 'executed', 'rejected')
       ORDER BY d.decided_at DESC NULLS LAST LIMIT $2) last`, [agentDefinitionId, minDecided]);
  if (!r || r.n < minDecided || r.ok / r.n >= minRate) return false;
  return pauseAgent(tx, agentDefinitionId, "quality_breaker");
}

export async function listAgents(tx: TenantTx) {
  const { rows } = await tx.client.query(
    `SELECT d.id, d.template_key, d.name, d.version, d.status, d.paused_reason, d.credit_budget_daily, d.credit_budget_monthly, d.run_as, d.created_at, d.updated_at,
            (SELECT coalesce(sum(credits), 0)::float FROM abcrm.agent_usage_daily u WHERE u.agent_definition_id = d.id AND u.date = current_date) AS credits_today,
            (SELECT coalesce(sum(credits), 0)::float FROM abcrm.agent_usage_daily u WHERE u.agent_definition_id = d.id AND u.date >= date_trunc('month', current_date)) AS credits_month
     FROM abcrm.agent_definitions d WHERE d.status <> 'archived' ORDER BY d.created_at`);
  return rows;
}

export async function getAgent(tx: TenantTx, id: string) {
  const row = (await listAgents(tx)).find((a) => a.id === id);
  if (!row) throw notFound("Agent");
  return row;
}

export async function updateAgentBudgets(tx: TenantTx, id: string, b: { daily?: number | null; monthly?: number | null }) {
  await getAgent(tx, id);
  await tx.client.query(
    `UPDATE abcrm.agent_definitions SET
       credit_budget_daily = CASE WHEN $2 THEN $3::int ELSE credit_budget_daily END,
       credit_budget_monthly = CASE WHEN $4 THEN $5::int ELSE credit_budget_monthly END
     WHERE id = $1`, [id, b.daily !== undefined, b.daily ?? null, b.monthly !== undefined, b.monthly ?? null]);
  return getAgent(tx, id);
}

/** Manual pause/resume. Resuming clears budget/anomaly/quality pauses; a person decides that the cause is fixed. */
export async function setAgentStatus(tx: TenantTx, id: string, op: "pause" | "resume") {
  const a = await getAgent(tx, id);
  if (op === "pause") await pauseAgent(tx, id, "manual");
  else if (a.status === "paused") {
    await tx.client.query("UPDATE abcrm.agent_definitions SET status = 'active', paused_reason = NULL WHERE id = $1", [id]);
    await emit(tx, "agents.agent.resumed", { agent_definition_id: id });
  }
  return getAgent(tx, id);
}

export async function setKillSwitch(tx: TenantTx, enabled: boolean) {
  await tx.client.query("UPDATE abcrm.tenants SET kill_switch = $2 WHERE id = $1", [tx.tenantId, enabled]);
  await emit(tx, "iam.tenant.kill_switch_changed", { enabled });
  return { kill_switch: enabled };
}
