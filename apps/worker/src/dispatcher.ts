import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Pool } from "@abcrm/db";
import { DECISION_TOPIC, decisionWaitId } from "./workflows/decision-wait.js";

export type OutboxEvent = {
  id: string; tenant_id: string; topic: string; payload: Record<string, unknown>;
  causation_id: string | null; correlation_id: string | null; created_at: Date;
};

export type EventHandler = (event: OutboxEvent) => Promise<void>;
const handlers = new Map<string, EventHandler>();

/** Registers a consumer for a topic. Must run before the engine launches (handlers execute inside routeEvent). */
export function onEvent(topic: string, handler: EventHandler): void {
  if (handlers.has(topic)) throw new Error(`handler already registered for ${topic}`);
  handlers.set(topic, handler);
}

/** Routes one event. Runs as a DBOS workflow whose ID is the event id, so redelivery is a no-op. */
async function routeEvent(event: OutboxEvent): Promise<void> {
  switch (event.topic) {
    case "decisions.decision.approved":
    case "decisions.decision.rejected": {
      const decisionId = String(event.payload.decision_id);
      const status = event.topic.endsWith("rejected") ? "rejected" : event.payload.edited ? "edited" : "approved";
      const waiter = decisionWaitId(decisionId);
      // Not every decision has a parked workflow (e.g. G-T1 approved in the UI); skip those.
      const waiting = await DBOS.runStep(async () => (await DBOS.getWorkflowStatus(waiter)) !== null, { name: "hasWaiter" });
      if (waiting) await DBOS.send(waiter, { status }, DECISION_TOPIC, `evt:${event.id}`);
      return;
    }
    default:
      await handlers.get(event.topic)?.(event);   // topics without a consumer are acknowledged and dropped
      return;
  }
}

const routeEventWf = DBOS.registerWorkflow(routeEvent, { name: "routeEvent" });

/** Claims a batch, starts one idempotent workflow per event, then marks the batch dispatched. */
export async function dispatchOnce(pool: Pool, batch = 100): Promise<number> {
  const { rows } = await pool.query<OutboxEvent>("SELECT * FROM abcrm.claim_outbox($1)", [batch]);
  if (rows.length === 0) return 0;
  const handles = await Promise.all(rows.map((e) => DBOS.startWorkflow(routeEventWf, { workflowID: `evt:${e.id}` })(e)));
  await Promise.all(handles.map((h) => h.getResult()));
  await pool.query("SELECT abcrm.mark_outbox_dispatched($1)", [rows.map((r) => r.id)]);
  return rows.length;
}

export function startDispatcher(pool: Pool, intervalMs = 1000): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        if ((await dispatchOnce(pool)) === 0) await new Promise((r) => setTimeout(r, intervalMs));
      } catch (err) {
        console.error("dispatcher error", err);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  };
  void loop();
  return () => { stopped = true; };
}
