import type { TenantTx } from "@abcrm/db";
import { uuidv7 } from "./ids.js";

export type EventOptions = { causationId?: string; correlationId?: string };

/** Writes an event in the caller's transaction (events.md §1). Payload must contain IDs only, no PII. */
export async function emit(tx: TenantTx, topic: string, payload: Record<string, unknown>, opts: EventOptions = {}): Promise<string> {
  const id = uuidv7();
  await tx.client.query(
    "INSERT INTO abcrm.outbox(id, tenant_id, topic, payload, causation_id, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, tx.tenantId, topic, payload, opts.causationId ?? null, opts.correlationId ?? null],
  );
  return id;
}

export type NotificationInput = { userId: string; kind: string; title: string; body: string; payload?: Record<string, unknown>; email?: boolean };

/**
 * In-app notification for a staff user (never prospect PII in title/body/payload). Email delivery happens in the
 * worker through the Mailer adapter, triggered by the event in the same transaction.
 */
export async function notify(tx: TenantTx, n: NotificationInput): Promise<string> {
  const id = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.notifications(id, tenant_id, user_id, kind, title, body, payload, email_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, tx.tenantId, n.userId, n.kind, n.title, n.body, n.payload ?? {}, n.email === false ? "none" : "pending"]);
  if (n.email !== false) await emit(tx, "notifications.notification.created", { notification_id: id, kind: n.kind });
  return id;
}

/** Notifies every active user with one of the roles (e.g. owners/admins for billing alerts). */
export async function notifyRoles(tx: TenantTx, roles: string[], n: Omit<NotificationInput, "userId">): Promise<number> {
  const { rows } = await tx.client.query<{ id: string }>("SELECT id FROM abcrm.users WHERE status = 'active' AND role = ANY($1)", [roles]);
  for (const u of rows) await notify(tx, { ...n, userId: u.id });
  return rows.length;
}
