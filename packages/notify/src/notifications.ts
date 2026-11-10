import { withTenant, type Pool, type TenantTx } from "@abcrm/db";
import { notFound, notify } from "@abcrm/core";
import type { Mailer } from "./mailer.js";

const system = { type: "system", id: "notifications" } as const;

export async function listNotifications(tx: TenantTx, userId: string, opts: { unreadOnly?: boolean; limit: number }) {
  const { rows } = await tx.client.query(
    `SELECT id, kind, title, body, payload, read_at, created_at FROM abcrm.notifications
     WHERE user_id = $1 AND ($2 = false OR read_at IS NULL) ORDER BY created_at DESC LIMIT $3`, [userId, opts.unreadOnly ?? false, opts.limit]);
  const { rows: [c] } = await tx.client.query<{ n: number }>("SELECT count(*)::int AS n FROM abcrm.notifications WHERE user_id = $1 AND read_at IS NULL", [userId]);
  return { data: rows, unread: c!.n };
}

export async function markRead(tx: TenantTx, userId: string, id: string) {
  const { rowCount } = await tx.client.query("UPDATE abcrm.notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!rowCount) throw notFound("Notification");
  return { id, read: true };
}

/** Worker: emails one notification through the Mailer; disabled adapter → `skipped`, the in-app copy stays. */
export async function deliverNotification(pool: Pool, mailer: Mailer, tenantId: string, notificationId: string): Promise<string> {
  const n = await withTenant(pool, tenantId, system, async (tx) => (await tx.client.query<{ title: string; body: string; email: string; email_status: string }>(
    `SELECT n.title, n.body, u.email, n.email_status FROM abcrm.notifications n JOIN abcrm.users u ON u.id = n.user_id WHERE n.id = $1`, [notificationId])).rows[0]);
  if (!n || n.email_status !== "pending") return n?.email_status ?? "missing";
  let status: "sent" | "skipped" | "failed";
  try {
    status = (await mailer.send({ to: n.email, subject: `[ABCRM] ${n.title}`, text: `${n.body}\n\n— ABCRM` })).status;
  } catch {
    status = "failed";
  }
  await withTenant(pool, tenantId, system, (tx) => tx.client.query("UPDATE abcrm.notifications SET email_status = $2 WHERE id = $1", [notificationId, status]));
  return status;
}

/**
 * Morning digest (decision-inbox.md §3) at 08:00 in the user's zone: pending cards they can act on (their own and
 * unassigned for reps, all for heads/admins), Tier A count and overdue count. Marked as sent even when empty.
 */
export async function sendDigest(tx: TenantTx, userId: string, localDate: string): Promise<boolean> {
  const { rows: [u] } = await tx.client.query<{ role: string; last_digest_date: string | null }>(
    "SELECT role, to_char(last_digest_date, 'YYYY-MM-DD') AS last_digest_date FROM abcrm.users WHERE id = $1 FOR UPDATE", [userId]);
  if (!u || (u.last_digest_date && u.last_digest_date >= localDate)) return false;
  const { rows: [c] } = await tx.client.query<{ total: number; tier_a: number; overdue: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE s.tier = 'A')::int AS tier_a, count(*) FILTER (WHERE d.sla_due_at < now())::int AS overdue
     FROM abcrm.decisions d JOIN abcrm.scorecards s ON s.id = (d.action->'args'->>'scorecardId')::uuid
     WHERE d.gate_id = 'G-Q' AND d.status = 'pending' AND (d.snoozed_until IS NULL OR d.snoozed_until <= now())
       AND ($2 <> 'sales_rep' OR d.assignee_user_id = $1 OR d.assignee_user_id IS NULL)`, [userId, u.role]);
  await tx.client.query("UPDATE abcrm.users SET last_digest_date = $2::date WHERE id = $1", [userId, localDate]);
  if (!c!.total) return false;
  await notify(tx, {
    userId, kind: "digest", title: `${c!.total} cards ready, ${c!.tier_a} Tier A`,
    body: `${c!.total} buyer cards are waiting for your decision (${c!.tier_a} Tier A${c!.overdue ? `, ${c!.overdue} past SLA` : ""}).`,
    payload: { total: c!.total, tier_a: c!.tier_a, overdue: c!.overdue },
  });
  return true;
}
