import type { TenantTx } from "@abcrm/db";
import { uuidv7 } from "@abcrm/core";
import type { LlmUsage } from "./types.js";

export type CostKind = "llm" | "search" | "fetch" | "contact_provider" | "email_verify";

/** Internal cost (not billed) for margin tracking (pricing doc §3). */
export async function recordCost(
  tx: TenantTx, c: { kind: CostKind; vendor: string; units: number; costUsdMicros: number; agentRunId?: string | null; meterLink?: string | null },
): Promise<void> {
  await tx.client.query(
    `INSERT INTO abcrm.cost_ledger(id, tenant_id, occurred_at, kind, vendor, units, cost_usd_micros, agent_run_id, meter_link)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)`,
    [uuidv7(), tx.tenantId, c.kind, c.vendor, c.units, c.costUsdMicros, c.agentRunId ?? null, c.meterLink ?? null]);
}

export function recordLlmCost(tx: TenantTx, u: LlmUsage, opts: { agentRunId?: string | null; meterLink?: string | null } = {}) {
  return recordCost(tx, { kind: "llm", vendor: u.model, units: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens,
    costUsdMicros: u.costUsdMicros, ...opts });
}

/** Sums usages (one agent run makes several calls). */
export function sumUsage(us: LlmUsage[]): { input: number; output: number; cache_read: number; cache_write: number; cost_usd_micros: number } {
  return us.reduce((s, u) => ({ input: s.input + u.inputTokens, output: s.output + u.outputTokens, cache_read: s.cache_read + u.cacheReadTokens,
    cache_write: s.cache_write + u.cacheWriteTokens, cost_usd_micros: s.cost_usd_micros + u.costUsdMicros }),
  { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd_micros: 0 });
}
