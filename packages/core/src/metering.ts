import type { TenantTx } from "@abcrm/db";
import { uuidv7 } from "./ids.js";
import { emit } from "./outbox.js";
import { Problem } from "./problem.js";

export type Meter = "agent" | "contact";

export type UsageInput = {
  idempotencyKey: string;
  meter: Meter;
  actionType: string;
  credits: number;
  agentDefinitionId?: string | null;
  agentRunId?: string | null;
  decisionId?: string | null;
  sourcingRunId?: string | null;
  billable?: boolean;
  /** Settles this reservation in the same transaction: the reserved amount is released and `credits` charged instead. */
  reservationKey?: string;
};

export type Balance = {
  meter: Meter; period: string; included: number; used: number; reserved: number; overage_enabled: boolean; spend_cap_usd: number | null;
  overage_unit_price_usd: number; hard_stop: boolean;
};

const THRESHOLDS = [50, 80, 100];

/** Creates this month's balance rows from the tenant's plan (idempotent). Returns the period start (YYYY-MM-DD). */
export async function ensureBalances(tx: TenantTx): Promise<string> {
  const { rows: [p] } = await tx.client.query<{ period: string }>("SELECT to_char(date_trunc('month', now()), 'YYYY-MM-DD') AS period");
  await tx.client.query(
    `INSERT INTO abcrm.usage_balances(tenant_id, period, meter, included, overage_enabled, spend_cap_usd, overage_unit_price_usd, hard_stop)
     SELECT t.id, $1::date, m.meter,
            CASE m.meter WHEN 'agent' THEN pe.included_agent_credits ELSE pe.included_contact_credits END,
            pe.overage_default,
            pe.spend_cap_default_usd,
            CASE m.meter WHEN 'agent' THEN pe.overage_agent_unit_usd ELSE pe.overage_contact_unit_usd END,
            NOT pe.overage_default
     FROM abcrm.tenants t JOIN abcrm.plan_entitlements pe ON pe.plan = t.plan CROSS JOIN (VALUES ('agent'), ('contact')) AS m(meter)
     WHERE t.id = $2
     ON CONFLICT (tenant_id, period, meter) DO NOTHING`, [p!.period, tx.tenantId]);
  return p!.period;
}

export async function getBalances(tx: TenantTx): Promise<Balance[]> {
  const period = await ensureBalances(tx);
  const { rows } = await tx.client.query<Balance>(
    `SELECT meter, to_char(period, 'YYYY-MM-DD') AS period, included::float AS included, used::float AS used, reserved::float AS reserved, overage_enabled,
            spend_cap_usd::float AS spend_cap_usd, overage_unit_price_usd::float AS overage_unit_price_usd, hard_stop
     FROM abcrm.usage_balances WHERE period = $1::date ORDER BY meter`, [period]);
  return rows;
}

/** Whether `credits` more can be spent on a meter (pricing doc §3): within included, or within overage and the spend cap. */
export function allows(b: Balance, credits: number): boolean {
  const after = b.used + (b.reserved ?? 0) + credits;
  if (after <= b.included) return true;
  if (!b.overage_enabled || b.hard_stop) return false;
  if (b.spend_cap_usd === null) return true;
  return (after - b.included) * b.overage_unit_price_usd <= b.spend_cap_usd + 1e-9;
}

export async function canSpend(tx: TenantTx, meter: Meter, credits: number): Promise<boolean> {
  const b = (await getBalances(tx)).find((x) => x.meter === meter)!;
  return allows(b, credits);
}

/** Cheap pre-check (no reservation). Work that must not overshoot the cap uses reserveCredits instead. Compliance actions never call either (§1.4). */
export async function assertCanSpend(tx: TenantTx, meter: Meter, credits: number): Promise<void> {
  if (!(await canSpend(tx, meter, credits))) {
    throw new Problem("quota-exhausted", meter === "agent" ? "Agent credits exhausted" : "Contact credits exhausted", { meter });
  }
}

/**
 * Appends a usage event exactly once per idempotency key (ADR-007), charges the tenant balance in the same
 * transaction, emits threshold events and applies per-agent guardrails. Returns false for a retry.
 */
export async function recordUsage(tx: TenantTx, u: UsageInput): Promise<boolean> {
  const { rowCount } = await tx.client.query(
    "INSERT INTO abcrm.usage_idempotency(tenant_id, idempotency_key) VALUES ($1, $2) ON CONFLICT DO NOTHING", [tx.tenantId, u.idempotencyKey]);
  if (!rowCount) return false;
  await tx.client.query(
    `INSERT INTO abcrm.usage_events(id, tenant_id, idempotency_key, occurred_at, meter, action_type, credits, agent_definition_id, agent_run_id,
       decision_id, sourcing_run_id, billable)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10, $11)`,
    [uuidv7(), tx.tenantId, u.idempotencyKey, u.meter, u.actionType, u.credits, u.agentDefinitionId ?? null, u.agentRunId ?? null,
      u.decisionId ?? null, u.sourcingRunId ?? null, u.billable ?? true]);
  if (u.reservationKey) await settleReservation(tx, u.reservationKey, "committed");
  if ((u.billable ?? true) && u.credits !== 0) await charge(tx, u.meter, u.credits);
  if (u.agentDefinitionId && u.credits > 0) await applyAgentGuardrails(tx, u.agentDefinitionId, u.credits);
  return true;
}

const ALLOWS_SQL = `(used + reserved + $3 <= included OR (overage_enabled AND NOT hard_stop AND
  (spend_cap_usd IS NULL OR (used + reserved + $3 - included) * overage_unit_price_usd <= spend_cap_usd)))`;

/**
 * Reserves credits before chargeable work (§4 step 1). Atomic: the conditional UPDATE locks the balance row, so
 * concurrent reservations cannot together pass the cap. Idempotent per key. Returns false when the balance does not allow it.
 */
export async function reserveCredits(tx: TenantTx, meter: Meter, credits: number, key: string): Promise<boolean> {
  const { rows: [prev] } = await tx.client.query<{ status: string }>("SELECT status FROM abcrm.usage_reservations WHERE key = $1", [key]);
  if (prev) return prev.status !== "released";
  const period = await ensureBalances(tx);
  const { rowCount } = await tx.client.query(
    `UPDATE abcrm.usage_balances SET reserved = reserved + $3, updated_at = now() WHERE period = $1::date AND meter = $2 AND ${ALLOWS_SQL}`,
    [period, meter, credits]);
  if (!rowCount) return false;
  await tx.client.query("INSERT INTO abcrm.usage_reservations(tenant_id, key, period, meter, credits) VALUES ($1, $2, $3::date, $4, $5)",
    [tx.tenantId, key, period, meter, credits]);
  return true;
}

/** Releases an unused reservation (§4 step 3). No-op when already settled or unknown. */
export const releaseReservation = (tx: TenantTx, key: string) => settleReservation(tx, key, "released");

async function settleReservation(tx: TenantTx, key: string, status: "committed" | "released") {
  const { rows: [r] } = await tx.client.query<{ period: string; meter: Meter; credits: number }>(
    `UPDATE abcrm.usage_reservations SET status = $2, settled_at = now() WHERE key = $1 AND status = 'reserved'
     RETURNING to_char(period, 'YYYY-MM-DD') AS period, meter, credits::float AS credits`, [key, status]);
  if (r) {
    await tx.client.query("UPDATE abcrm.usage_balances SET reserved = greatest(0, reserved - $3) WHERE period = $1::date AND meter = $2",
      [r.period, r.meter, r.credits]);
  }
}

async function charge(tx: TenantTx, meter: Meter, credits: number) {
  const period = await ensureBalances(tx);
  const { rows: [b] } = await tx.client.query<{ before: number; after: number; included: number; overage_enabled: boolean; hard_stop: boolean;
    spend_cap_usd: number | null; unit: number; reserved: number }>(
    `UPDATE abcrm.usage_balances SET used = greatest(0, used + $3), updated_at = now() WHERE period = $1::date AND meter = $2
     RETURNING (used - $3)::float AS before, used::float AS after, included::float AS included, overage_enabled, hard_stop,
               spend_cap_usd::float AS spend_cap_usd, overage_unit_price_usd::float AS unit, reserved::float AS reserved`, [period, meter, credits]);
  if (!b || b.included <= 0) return;
  for (const pct of THRESHOLDS) {
    const line = (b.included * pct) / 100;
    if (b.before < line && b.after >= line) await emit(tx, "billing.balance.threshold_crossed", { meter, pct, period });
  }
  const bal: Balance = { meter, period, included: b.included, used: b.after, reserved: b.reserved, overage_enabled: b.overage_enabled, spend_cap_usd: b.spend_cap_usd,
    overage_unit_price_usd: b.unit, hard_stop: b.hard_stop };
  const wasOpen = allows({ ...bal, used: b.before }, 0.1);
  if (wasOpen && !allows(bal, 0.1)) await emit(tx, "billing.balance.exhausted", { meter, period });
}

/** Per-agent guardrails (pricing doc §3.1): daily/monthly budgets and the spend anomaly breaker. */
async function applyAgentGuardrails(tx: TenantTx, agentId: string, credits: number) {
  const { rows: [today] } = await tx.client.query<{ credits: number }>(
    `INSERT INTO abcrm.agent_usage_daily(tenant_id, agent_definition_id, date, credits) VALUES ($1, $2, current_date, $3)
     ON CONFLICT (tenant_id, agent_definition_id, date) DO UPDATE SET credits = agent_usage_daily.credits + EXCLUDED.credits
     RETURNING credits::float AS credits`, [tx.tenantId, agentId, credits]);
  const { rows: [a] } = await tx.client.query<{ status: string; daily: number | null; monthly: number | null; month: number; avg7: number | null; days: number }>(
    `SELECT d.status, d.credit_budget_daily AS daily, d.credit_budget_monthly AS monthly,
            (SELECT coalesce(sum(credits), 0)::float FROM abcrm.agent_usage_daily WHERE agent_definition_id = d.id AND date >= date_trunc('month', current_date)) AS month,
            (SELECT avg(credits)::float FROM abcrm.agent_usage_daily WHERE agent_definition_id = d.id AND date BETWEEN current_date - 7 AND current_date - 1) AS avg7,
            (SELECT count(*)::int FROM abcrm.agent_usage_daily WHERE agent_definition_id = d.id AND date BETWEEN current_date - 7 AND current_date - 1) AS days
     FROM abcrm.agent_definitions d WHERE d.id = $1`, [agentId]);
  if (!a || a.status !== "active") return;
  const used = today!.credits;
  let reason: "budget" | "anomaly" | null = null;
  if ((a.daily !== null && used >= a.daily) || (a.monthly !== null && a.month >= a.monthly)) reason = "budget";
  else if (a.avg7 !== null && a.days >= 3 && used >= 50) {
    if (used > 5 * a.avg7) reason = "anomaly";
    else if (used > 3 * a.avg7 && used - credits <= 3 * a.avg7) {
      await emit(tx, "agents.agent.anomaly_detected", { agent_definition_id: agentId, credits_today: used, avg_7d: a.avg7 });
    }
  }
  if (reason) await pauseAgent(tx, agentId, reason);
}

export async function pauseAgent(tx: TenantTx, agentId: string, reason: "manual" | "budget" | "anomaly" | "quality_breaker" | "entitlement" | "kill_switch") {
  const { rowCount } = await tx.client.query(
    "UPDATE abcrm.agent_definitions SET status = 'paused', paused_reason = $2 WHERE id = $1 AND status = 'active'", [agentId, reason]);
  if (rowCount) await emit(tx, "agents.agent.paused", { agent_definition_id: agentId, reason });
  return (rowCount ?? 0) > 0;
}

/** PATCH /usage/settings (owner/admin): overage on/off and spend caps for the current period and the plan default going forward. */
export async function updateUsageSettings(tx: TenantTx, s: { meter: Meter; overageEnabled?: boolean; spendCapUsd?: number | null }) {
  const period = await ensureBalances(tx);
  await tx.client.query(
    `UPDATE abcrm.usage_balances SET
       overage_enabled = coalesce($3, overage_enabled), hard_stop = NOT coalesce($3, overage_enabled),
       spend_cap_usd = CASE WHEN $4 THEN $5::numeric ELSE spend_cap_usd END, updated_at = now()
     WHERE period = $1::date AND meter = $2`,
    [period, s.meter, s.overageEnabled ?? null, s.spendCapUsd !== undefined, s.spendCapUsd ?? null]);
  await emit(tx, "billing.settings.changed", { meter: s.meter });
  return getBalances(tx);
}

/** GET /usage: balances plus this period's consumption by action and by agent (usage dashboard, pricing doc §5). */
export async function usageSummary(tx: TenantTx) {
  const balances = await getBalances(tx);
  const period = balances[0]!.period;
  const { rows: byAction } = await tx.client.query(
    `SELECT meter, action_type, count(*)::int AS events, sum(credits)::float AS credits FROM abcrm.usage_events
     WHERE occurred_at >= $1::date AND billable GROUP BY meter, action_type ORDER BY meter, action_type`, [period]);
  const { rows: byAgent } = await tx.client.query(
    `SELECT e.agent_definition_id, d.template_key, d.name, sum(e.credits)::float AS credits FROM abcrm.usage_events e
     JOIN abcrm.agent_definitions d ON d.id = e.agent_definition_id
     WHERE e.occurred_at >= $1::date AND e.billable GROUP BY e.agent_definition_id, d.template_key, d.name ORDER BY credits DESC`, [period]);
  return { period, balances, by_action: byAction, by_agent: byAgent };
}
