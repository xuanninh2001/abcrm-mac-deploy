import { DBOS } from "@dbos-inc/dbos-sdk";
import { withTenant, type Pool } from "@abcrm/db";

export type DecisionOutcome = "approved" | "edited" | "rejected" | "expired";
export const DECISION_TOPIC = "decision";
export const decisionWaitId = (decisionId: string) => `decision-wait:${decisionId}`;

/**
 * Parks an agent run until a person decides (system design §6, ADR-009). The wait is durable:
 * if the worker restarts, DBOS recovers the workflow and keeps waiting. On timeout the decision is
 * expired so it disappears from the Inbox.
 */
export function registerDecisionWait(pool: Pool) {
  /** Expires a still-pending decision; otherwise returns the status a person already set. */
  async function settleOnTimeout(tenantId: string, decisionId: string): Promise<DecisionOutcome> {
    return withTenant(pool, tenantId, { type: "system", id: "decision-wait" }, async (tx) => {
      const expired = await tx.client.query("UPDATE abcrm.decisions SET status = 'expired' WHERE id = $1 AND status = 'pending'", [decisionId]);
      if (expired.rowCount === 1) return "expired";
      const { rows: [d] } = await tx.client.query<{ status: string }>("SELECT status FROM abcrm.decisions WHERE id = $1", [decisionId]);
      return d && ["approved", "edited", "rejected"].includes(d.status) ? (d.status as DecisionOutcome) : "expired";
    });
  }

  async function awaitDecision(tenantId: string, decisionId: string, timeoutSeconds: number): Promise<DecisionOutcome> {
    const msg = await DBOS.recv<{ status: DecisionOutcome }>(DECISION_TOPIC, { timeoutSeconds });
    if (msg) return msg.status;
    // Timed out (or the signal was missed): the database is the source of truth.
    return DBOS.runStep(() => settleOnTimeout(tenantId, decisionId), { name: "settleOnTimeout" });
  }

  return DBOS.registerWorkflow(awaitDecision, { name: "awaitDecision" });
}

export const startDecisionWait = (wf: ReturnType<typeof registerDecisionWait>, tenantId: string, decisionId: string, timeoutSeconds: number) =>
  DBOS.startWorkflow(wf, { workflowID: decisionWaitId(decisionId) })(tenantId, decisionId, timeoutSeconds);
