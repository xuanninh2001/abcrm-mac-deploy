import type { Actor, TenantTx } from "@abcrm/db";
import { appendAudit, emit, notFound, Problem } from "@abcrm/core";
import { proposeDecision } from "@abcrm/agents";

/**
 * Shared lifecycle for versioned, lineage-based setup objects (playbooks, IPPs):
 * draft → pending_approval (G-T1) → active (previous active in the lineage archived) | back to draft on reject.
 */
export type VersionedTable = "playbooks" | "ipps";
const SUBJECT: Record<VersionedTable, string> = { playbooks: "playbook", ipps: "ipp" };

export async function draftInLineage(tx: TenantTx, table: VersionedTable, lineageId: string) {
  const { rows: [d] } = await tx.client.query<{ id: string; status: string; version: number }>(
    `SELECT id, status, version FROM abcrm.${table} WHERE lineage_id = $1 AND status IN ('draft', 'pending_approval') FOR UPDATE`, [lineageId]);
  return d ?? null;
}

export async function nextVersion(tx: TenantTx, table: VersionedTable, lineageId: string): Promise<number> {
  const { rows: [r] } = await tx.client.query<{ next: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS next FROM abcrm.${table} WHERE lineage_id = $1`, [lineageId]);
  return r!.next;
}

export async function submitVersion(tx: TenantTx, actor: Actor, table: VersionedTable, id: string, label: string, evidence?: Record<string, unknown>) {
  const { rows: [row] } = await tx.client.query<{ status: string; version: number; lineage_id: string }>(
    `SELECT status, version, lineage_id FROM abcrm.${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!row) throw notFound(label);
  if (row.status !== "draft") throw new Problem("conflict", `${label} is ${row.status}`);
  await tx.client.query(`UPDATE abcrm.${table} SET status = 'pending_approval' WHERE id = $1`, [id]);
  const decisionId = await proposeDecision(tx, {
    gate: "G-T1", lane: "setup", subject: { type: SUBJECT[table], id },
    action: { tool: "setup.activate", args: { kind: SUBJECT[table], id, version: row.version } },
    proposedBy: actor.type === "user" ? { type: "user", userId: actor.id } : { type: "agent", agentRunId: actor.id },
    explanation: `Activate ${label} v${row.version}`,
    evidence,
  });
  await emit(tx, `${SUBJECT[table]}.submitted`, { [`${SUBJECT[table]}_id`]: id, version: row.version });
  return { decisionId };
}

export async function activateVersion(tx: TenantTx, actor: Actor, table: VersionedTable, id: string, decisionId: string, label: string) {
  const { rows: [row] } = await tx.client.query<{ status: string; version: number; lineage_id: string }>(
    `SELECT status, version, lineage_id FROM abcrm.${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!row) throw notFound(label);
  if (row.status !== "pending_approval") throw new Problem("conflict", `${label} is ${row.status}`);
  await tx.client.query(`UPDATE abcrm.${table} SET status = 'archived' WHERE lineage_id = $1 AND status = 'active'`, [row.lineage_id]);
  await tx.client.query(`UPDATE abcrm.${table} SET status = 'active', approved_decision_id = $2 WHERE id = $1`, [id, decisionId]);
  await appendAudit(tx, { actor, action: `${SUBJECT[table]}.activated`, subject: { type: SUBJECT[table], id } });
  await emit(tx, `${SUBJECT[table]}.activated`, { [`${SUBJECT[table]}_id`]: id, version: row.version });
}

export async function returnVersionToDraft(tx: TenantTx, table: VersionedTable, id: string) {
  await tx.client.query(`UPDATE abcrm.${table} SET status = 'draft' WHERE id = $1 AND status = 'pending_approval'`, [id]);
}
