import { DBOS } from "@dbos-inc/dbos-sdk";

/**
 * Thin seam over the durable-execution engine (ADR-009) so DBOS can be swapped (e.g. Temporal)
 * without touching workflow call sites.
 */
export interface WorkflowEngine {
  /** Delivers a message to a running workflow; `idempotencyKey` makes redelivery a no-op. */
  signal(workflowId: string, topic: string, message: unknown, idempotencyKey?: string): Promise<void>;
}

export const dbosEngine: WorkflowEngine = {
  signal: (workflowId, topic, message, idempotencyKey) => DBOS.send(workflowId, message, topic, idempotencyKey),
};

export async function launchEngine(systemDatabaseUrl: string): Promise<void> {
  DBOS.setConfig({ name: "abcrm-worker", systemDatabaseUrl, logLevel: process.env.DBOS_LOG_LEVEL ?? "warn" });
  await DBOS.launch();
}

export const shutdownEngine = () => DBOS.shutdown();
