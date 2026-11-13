import { DBOS } from "@dbos-inc/dbos-sdk";
import { withTenant } from "@abcrm/db";
import { runSourcing, type EngineDeps, type SearchProvider } from "@abcrm/sourcing";
import type { LlmGateway } from "@abcrm/llm";
import { onEvent } from "../dispatcher.js";
import { agentQueue } from "../queues.js";

export type SourcingWorkerDeps = Omit<EngineDeps, "step" | "search"> & { search: SearchProvider | null; resolveLlm?: (tenantId: string) => Promise<LlmGateway | null> };

/**
 * Registers the sourcing workflow and its trigger (`sourcing.run.queued`). Each engine step is a DBOS step,
 * so a restarted worker resumes the run from its last checkpoint.
 */
export function registerSourcing(deps: SourcingWorkerDeps) {
  async function sourcingRun(tenantId: string, runId: string) {
    if (!deps.search) {
      await DBOS.runStep(() => withTenant(deps.pool, tenantId, { type: "system", id: "sourcing" }, (tx) => tx.client.query(
        `UPDATE abcrm.sourcing_runs SET status = 'failed', finished_at = now(), stats = stats || '{"error":"search provider not configured"}'
         WHERE id = $1 AND status IN ('queued', 'running')`, [runId])), { name: "noProvider" });
      return { status: "failed" };
    }
    const llm = deps.resolveLlm ? await deps.resolveLlm(tenantId) : deps.llm;
    return runSourcing({ ...deps, llm, search: deps.search, step: (name, fn) => DBOS.runStep(fn, { name }) }, tenantId, runId);
  }
  const wf = DBOS.registerWorkflow(sourcingRun, { name: "sourcingRun" });

  onEvent("sourcing.run.queued", async (event) => {
    const runId = String(event.payload.sourcing_run_id);
    // One workflow per queue event: a resume after pause is a new event, so a new workflow continues the run.
    await DBOS.startWorkflow(wf, { workflowID: `sourcing-run:${runId}:${event.id}`, ...(await agentQueue(deps.pool, event.tenant_id)) })(event.tenant_id, runId);
  });
  return wf;
}
