import { createHash } from "node:crypto";
import type { TenantTx } from "@abcrm/db";
import { appendAudit, canonicalJson, emit, Problem, uuidv7 } from "@abcrm/core";
import { hasPermission, type Principal } from "./permissions.js";
import type { Gate } from "./tool.js";

export type Lane = "hot" | "hot-intent" | "contact" | "standard" | "setup";

export interface ProposeInput {
  gate: Gate;
  lane: Lane;
  subject: { type: string; id: string };
  action: { tool: string; args: Record<string, unknown> };
  proposedBy: { type: "agent"; agentRunId: string } | { type: "user"; userId: string };
  cardId?: string;
  explanation?: string;
  evidence?: Record<string, unknown>;
  assigneeRole?: string;
  slaDueAt?: Date;
  expiresAt?: Date;
  groupKey?: string;
}

export const contentHash = (action: unknown) => createHash("sha256").update(canonicalJson(action)).digest();

export async function proposeDecision(tx: TenantTx, p: ProposeInput): Promise<string> {
  const id = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.decisions(id, tenant_id, gate_id, card_id, lane, subject_type, subject_id, proposed_by, action,
       evidence, explanation, content_hash, assignee_role, sla_due_at, expires_at, group_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, tx.tenantId, p.gate, p.cardId ?? null, p.lane, p.subject.type, p.subject.id, p.proposedBy, p.action,
      p.evidence ?? {}, p.explanation ?? null, contentHash(p.action), p.assigneeRole ?? null, p.slaDueAt ?? null, p.expiresAt ?? null, p.groupKey ?? null]);
  await emit(tx, "decisions.decision.created", { decision_id: id, gate_id: p.gate, lane: p.lane, card_id: p.cardId ?? null });
  return id;
}

const APPROVE_PERMISSION: Partial<Record<Gate, Parameters<typeof hasPermission>[1]>> = {
  "G-Q": "decisions.approve.G-Q",
  "G-OUT": "decisions.approve.G-Q",     // first email is approved together with G-Q in Phase 1
  "G-T1": "setup.approve",
};

/**
 * Human approval. INV-2: only a user principal with the gate's approve permission can approve;
 * the caller must present the content hash they reviewed, so stale cards cannot be approved blindly.
 */
export async function approveDecision(
  tx: TenantTx, decisionId: string, approver: Principal, reviewedHash: Buffer,
  edit?: { action: { tool: string; args: Record<string, unknown> } },
): Promise<void> {
  if (approver.type !== "user") throw new Problem("permission-denied", "Only people can approve decisions");
  const { rows: [d] } = await tx.client.query<{ gate_id: Gate; status: string; content_hash: Buffer; action: { tool: string } }>(
    "SELECT gate_id, status, content_hash, action FROM abcrm.decisions WHERE id = $1 FOR UPDATE", [decisionId]);
  if (!d) throw new Problem("not-found", "Decision not found");
  const perm = APPROVE_PERMISSION[d.gate_id];
  if (!perm || !hasPermission(approver, perm)) throw new Problem("permission-denied", `Not allowed to approve ${d.gate_id}`);
  if (d.status !== "pending") throw new Problem("conflict", `Decision is ${d.status}`);
  if (!d.content_hash.equals(reviewedHash)) throw new Problem("precondition-failed", "Decision changed since it was reviewed");
  if (edit && edit.action.tool !== d.action.tool) throw new Problem("validation-failed", "An edit cannot change the tool");

  await tx.client.query(
    `UPDATE abcrm.decisions SET status = $2, decided_by = $3, decided_at = now(), final_action = $4, final_content_hash = $5
     WHERE id = $1`,
    [decisionId, edit ? "edited" : "approved", approver.id, edit?.action ?? null, edit ? contentHash(edit.action) : null]);
  await appendAudit(tx, { actor: { type: "user", id: approver.id }, action: "decision.approved", subject: { type: "decision", id: decisionId } });
  await emit(tx, "decisions.decision.approved", { decision_id: decisionId, gate_id: d.gate_id, edited: !!edit });
}

export async function rejectDecision(tx: TenantTx, decisionId: string, approver: Principal, reasonCode: string, note?: string) {
  if (approver.type !== "user") throw new Problem("permission-denied", "Only people can reject decisions");
  const { rows: [d] } = await tx.client.query<{ gate_id: Gate }>("SELECT gate_id FROM abcrm.decisions WHERE id = $1 FOR UPDATE", [decisionId]);
  if (!d) throw new Problem("not-found", "Decision not found");
  const perm = APPROVE_PERMISSION[d.gate_id];
  if (!perm || !hasPermission(approver, perm)) throw new Problem("permission-denied", `Not allowed to reject ${d.gate_id}`);
  const res = await tx.client.query(
    `UPDATE abcrm.decisions SET status = 'rejected', decided_by = $2, decided_at = now(), reject_reason_code = $3, reject_note = $4
     WHERE id = $1 AND status = 'pending'`, [decisionId, approver.id, reasonCode, note ?? null]);
  if (res.rowCount !== 1) throw new Problem("conflict", "Decision is not pending");
  await appendAudit(tx, { actor: { type: "user", id: approver.id }, action: "decision.rejected", subject: { type: "decision", id: decisionId } });
  await emit(tx, "decisions.decision.rejected", { decision_id: decisionId, reason_code: reasonCode });
}

/**
 * INV-3: claims an approved decision for execution exactly once. Concurrent executors race on the
 * conditional UPDATE; only one gets the row back. The handler runs in the same transaction, so a
 * failure rolls the claim back and the decision can be retried.
 */
export async function executeApproved<T>(
  tx: TenantTx, decisionId: string,
  handler: (action: { tool: string; args: Record<string, unknown> }) => Promise<T>,
): Promise<{ executed: true; result: T } | { executed: false }> {
  type Action = { tool: string; args: Record<string, unknown> };
  const { rows: [d] } = await tx.client.query<{ action: Action; final_action: Action | null }>(
    `UPDATE abcrm.decisions SET status = 'executed', executed_at = now()
     WHERE id = $1 AND status IN ('approved', 'edited') RETURNING action, final_action`, [decisionId]);
  if (!d) return { executed: false };
  return { executed: true, result: await handler(d.final_action ?? d.action) };
}
