import { DBOS } from "@dbos-inc/dbos-sdk";
import { withTenant, type Pool } from "@abcrm/db";

/** Plans whose queues are registered in this process (queue name `agents-<plan>`). */
const registered = new Set<string>();

/**
 * One partitioned DBOS queue per plan: `partitionConcurrency` = the plan's max_concurrency, partition = tenant
 * (pricing doc §2: concurrent agents are a plan capacity, not a count of agents). Must run after launch.
 */
export async function registerPlanQueues(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ plan: string; max_concurrency: number }>("SELECT plan, max_concurrency FROM abcrm.plan_entitlements");
  for (const r of rows) {
    await DBOS.registerQueue(`agents-${r.plan}`, { partitionConcurrency: r.max_concurrency });
    registered.add(r.plan);
  }
  return rows.map((r) => `agents-${r.plan}`);
}

/**
 * Start options that put an agent workflow on its tenant's plan queue. Called inside the event-routing
 * workflow, so the plan lookup is a step. Without registered queues (tests) workflows start directly.
 */
export async function agentQueue(pool: Pool, tenantId: string): Promise<{ queueName?: string; enqueueOptions?: { queuePartitionKey: string } }> {
  if (!registered.size) return {};
  const plan = await DBOS.runStep(() => withTenant(pool, tenantId, { type: "system", id: "queues" }, async (tx) =>
    (await tx.client.query<{ plan: string }>("SELECT plan FROM abcrm.tenants WHERE id = $1", [tenantId])).rows[0]?.plan ?? "trial"), { name: "tenantPlan" });
  return registered.has(plan) ? { queueName: `agents-${plan}`, enqueueOptions: { queuePartitionKey: tenantId } } : {};
}
