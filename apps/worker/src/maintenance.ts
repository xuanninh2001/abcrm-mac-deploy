import { withTenant, type Pool } from "@abcrm/db";
import { escalateCard } from "@abcrm/inbox";
import { sendDigest } from "@abcrm/notify";
import { reportUsage, type MeterReporter } from "@abcrm/billing";

const system = { type: "system", id: "maintenance" } as const;
export type MaintenanceDeps = { pool: Pool; reporter: MeterReporter; now?: () => Date; graceHours?: number };
export type MaintenanceResult = { expired: number; released: number; escalated: number; digests: number; usage: { reported: number; skipped: number; failed: number } | null };

let lastUsageHour = -1;

/**
 * One pass of the periodic jobs (every minute): card expiry, stale credit reservations, SLA escalations,
 * morning digests, and — once per hour — usage reporting. Each job is idempotent; a failure in one does not stop the others.
 */
export async function maintenanceOnce(d: MaintenanceDeps): Promise<MaintenanceResult> {
  const now = d.now?.() ?? new Date();
  const out: MaintenanceResult = { expired: 0, released: 0, escalated: 0, digests: 0, usage: null };
  const guard = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.error(`maintenance ${name}`, e); } };

  await guard("expiry", async () => { out.expired = (await d.pool.query("SELECT * FROM abcrm.expire_due_decisions(500)")).rowCount ?? 0; });
  await guard("reservations", async () => { out.released = (await d.pool.query<{ n: number }>("SELECT abcrm.release_stale_reservations('1 hour') AS n")).rows[0]!.n; });
  await guard("escalations", async () => {
    const { rows } = await d.pool.query<{ tenant_id: string; decision_id: string }>("SELECT * FROM abcrm.due_escalations(make_interval(hours => $1))", [d.graceHours ?? 4]);
    for (const r of rows) if (await withTenant(d.pool, r.tenant_id, system, (tx) => escalateCard(tx, r.decision_id, now))) out.escalated++;
  });
  await guard("digests", async () => {
    const { rows } = await d.pool.query<{ tenant_id: string; user_id: string; local_date: string }>(
      "SELECT tenant_id, user_id, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM abcrm.digest_due_users()");
    for (const r of rows) if (await withTenant(d.pool, r.tenant_id, system, (tx) => sendDigest(tx, r.user_id, r.local_date))) out.digests++;
  });
  if (now.getUTCHours() !== lastUsageHour) {
    await guard("usage", async () => {
      out.usage = await reportUsage(d.pool, d.reporter, new Date(now.getTime() - 48 * 3600_000));
      lastUsageHour = now.getUTCHours();
    });
  }
  return out;
}
