import type { TenantTx } from "@abcrm/db";
import { emit, notFound, notify, Problem, uuidv7 } from "@abcrm/core";
import { hasPermission, type Principal } from "@abcrm/agents";
import { addWorkingMinutes, isWorkingNow, oneWorkingDay, type WorkingHours } from "./sla.js";

type Rep = { id: string; role: string; timezone: string; working_hours: WorkingHours; pending: number; last_assigned: Date | null };

const REVIEWER_ROLES = ["sales_rep", "head_of_bd", "admin", "owner"];

/**
 * Round-robin among sales reps (decision-inbox.md §3): reps at work right now first, then fewest pending cards,
 * then longest since their last assignment. Falls back to head_of_bd when the tenant has no reps.
 */
export async function pickAssignee(tx: TenantTx, opts: { exclude?: string | null; now?: Date } = {}): Promise<Rep | null> {
  const now = opts.now ?? new Date();
  const { rows } = await tx.client.query<Rep>(
    `SELECT u.id, u.role, u.timezone, u.working_hours,
            (SELECT count(*)::int FROM abcrm.decisions d WHERE d.assignee_user_id = u.id AND d.status = 'pending' AND d.gate_id = 'G-Q') AS pending,
            (SELECT max(d.assigned_at) FROM abcrm.decisions d WHERE d.assignee_user_id = u.id) AS last_assigned
     FROM abcrm.users u WHERE u.status = 'active' AND u.role IN ('sales_rep', 'head_of_bd') AND u.id IS DISTINCT FROM $1`, [opts.exclude ?? null]);
  const rank = (r: Rep) => [r.role === "sales_rep" ? 0 : 1, isWorkingNow(now, r.timezone, r.working_hours) ? 0 : 1, r.pending, r.last_assigned?.getTime() ?? 0];
  rows.sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return a.id.localeCompare(b.id);
  });
  return rows[0] ?? null;
}

/** Assigns both decisions of a card and sets the SLA to one working day of the assignee (in their zone and hours). */
export async function assignCard(tx: TenantTx, cardId: string, userId?: string | null, now = new Date()): Promise<{ userId: string | null; slaDueAt: Date | null }> {
  let rep: Rep | null = null;
  if (userId) {
    const { rows: [u] } = await tx.client.query<Rep>(
      "SELECT id, role, timezone, working_hours, 0 AS pending, NULL::timestamptz AS last_assigned FROM abcrm.users WHERE id = $1 AND status = 'active'", [userId]);
    if (!u || !REVIEWER_ROLES.includes(u.role)) throw new Problem("validation-failed", "Assignee must be an active rep, head of BD, admin or owner");
    rep = u;
  } else rep = await pickAssignee(tx, { now });
  const sla = rep ? addWorkingMinutes(now, oneWorkingDay(rep.working_hours), rep.timezone, rep.working_hours) : null;
  await tx.client.query(
    `UPDATE abcrm.decisions SET assignee_user_id = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN assigned_at ELSE now() END,
       sla_due_at = coalesce($3, sla_due_at), escalation_level = 0
     WHERE card_id = $1 AND status = 'pending'`, [cardId, rep?.id ?? null, sla]);
  return { userId: rep?.id ?? null, slaDueAt: sla };
}

/** POST /cards/{id}/reassign (owner/admin/head_of_bd). */
export async function reassignCard(tx: TenantTx, principal: Principal, cardId: string, userId: string) {
  if (!hasPermission(principal, "decisions.reassign")) throw new Problem("permission-denied", "decisions.reassign required");
  const { rows: [d] } = await tx.client.query<{ status: string; subject_id: string }>(
    "SELECT status, subject_id FROM abcrm.decisions WHERE card_id = $1 AND gate_id = 'G-Q'", [cardId]);
  if (!d) throw notFound("Card");
  if (d.status !== "pending") throw new Problem("conflict", `Card is ${d.status}`);
  const r = await assignCard(tx, cardId, userId);
  await notify(tx, { userId, kind: "card_assigned", title: "A card was assigned to you", body: "Open the inbox to review it.", payload: { card_id: cardId } });
  await emit(tx, "decisions.card.reassigned", { card_id: cardId, assignee_user_id: userId, by: principal.id });
  return { card_id: cardId, assignee_user_id: r.userId, sla_due_at: r.slaDueAt };
}

/**
 * SLA escalation for one overdue card (worker sweep over due_escalations()):
 * level 0 → notify the assignee (and the card stays theirs); level 1 → reassign to another rep at work, or to
 * a head of BD, and notify heads of BD.
 */
export async function escalateCard(tx: TenantTx, decisionId: string, now = new Date()): Promise<{ level: number; assignee: string | null } | null> {
  const { rows: [d] } = await tx.client.query<{ card_id: string; escalation_level: number; assignee_user_id: string | null; status: string; sla_due_at: Date }>(
    "SELECT card_id, escalation_level, assignee_user_id, status, sla_due_at FROM abcrm.decisions WHERE id = $1 FOR UPDATE", [decisionId]);
  if (!d || d.status !== "pending") return null;
  if (d.escalation_level === 0) {
    await tx.client.query("UPDATE abcrm.decisions SET escalation_level = 1 WHERE card_id = $1 AND status = 'pending'", [d.card_id]);
    if (d.assignee_user_id) {
      await notify(tx, { userId: d.assignee_user_id, kind: "card_overdue", title: "A card is past its SLA", body: "Approve, reject or snooze it.", payload: { card_id: d.card_id } });
    }
    return { level: 1, assignee: d.assignee_user_id };
  }
  if (d.escalation_level !== 1) return null;
  const next = await pickAssignee(tx, { exclude: d.assignee_user_id, now });
  const target = next && (next.role === "head_of_bd" || isWorkingNow(now, next.timezone, next.working_hours)) ? next : null;
  const heads = (await tx.client.query<{ id: string }>("SELECT id FROM abcrm.users WHERE status = 'active' AND role = 'head_of_bd' ORDER BY created_at")).rows;
  const assignee = target?.id ?? heads[0]?.id ?? d.assignee_user_id;
  if (assignee && assignee !== d.assignee_user_id) {
    const sla = target ? addWorkingMinutes(now, oneWorkingDay(target.working_hours), target.timezone, target.working_hours) : null;
    await tx.client.query(
      `UPDATE abcrm.decisions SET assignee_user_id = $2, assigned_at = now(), sla_due_at = coalesce($3, sla_due_at) WHERE card_id = $1 AND status = 'pending'`,
      [d.card_id, assignee, sla]);
    await notify(tx, { userId: assignee, kind: "card_assigned", title: "An overdue card was reassigned to you", body: "Open the inbox to review it.", payload: { card_id: d.card_id } });
  }
  await tx.client.query("UPDATE abcrm.decisions SET escalation_level = 2 WHERE card_id = $1 AND status = 'pending'", [d.card_id]);
  for (const h of heads) {
    if (h.id === assignee) continue;
    await notify(tx, { userId: h.id, kind: "card_escalated", title: "A card was escalated", body: "It passed its SLA and was reassigned.", payload: { card_id: d.card_id, assignee_user_id: assignee } });
  }
  await emit(tx, "decisions.card.escalated", { card_id: d.card_id, assignee_user_id: assignee });
  return { level: 2, assignee };
}

/** "Mark as verified by me" (decision-inbox.md §1.1): a note on an unknown criterion; the scorecard does not change. */
export async function verifyCriterion(tx: TenantTx, principal: Principal, cardId: string, criterionKey: string, note: string) {
  if (principal.type !== "user" || !hasPermission(principal, "decisions.approve.G-Q")) throw new Problem("permission-denied", "Only reviewers can verify criteria");
  if (!note.trim()) throw new Problem("validation-failed", "A note is required");
  const { rows: [c] } = await tx.client.query<{ scorecard_id: string; criterion_id: string; result: string }>(
    `SELECT s.id AS scorecard_id, cr.criterion_id, cr.result FROM abcrm.decisions d
     JOIN abcrm.scorecards s ON s.id = (d.action->'args'->>'scorecardId')::uuid
     JOIN abcrm.criteria c ON c.playbook_id = s.playbook_id AND c.key = $2
     JOIN abcrm.criterion_results cr ON cr.scorecard_id = s.id AND cr.criterion_id = c.id
     WHERE d.card_id = $1 AND d.gate_id = 'G-Q'`, [cardId, criterionKey]);
  if (!c) throw notFound("Criterion on this card");
  if (c.result !== "unknown") throw new Problem("conflict", "Only unknown criteria can be marked as verified");
  await tx.client.query(
    `INSERT INTO abcrm.criterion_verifications(id, tenant_id, scorecard_id, criterion_id, user_id, note) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (scorecard_id, criterion_id, user_id) DO UPDATE SET note = EXCLUDED.note, created_at = now()`,
    [uuidv7(), tx.tenantId, c.scorecard_id, c.criterion_id, principal.id, note.slice(0, 1000)]);
  await emit(tx, "qualification.criterion.verified_by_rep", { card_id: cardId, criterion_key: criterionKey, user_id: principal.id });
  return { card_id: cardId, criterion_key: criterionKey, verified_by: principal.id };
}
