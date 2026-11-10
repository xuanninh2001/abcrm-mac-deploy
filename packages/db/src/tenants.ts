import { randomUUID } from "node:crypto";
import type { Pool } from "./pool.js";

export type NewTenant = {
  name: string; slug: string; plan?: string; country?: string; workosOrgId?: string;
  owner: { email: string; name?: string; timezone?: string };
};

/**
 * Onboards a tenant (runbook: onboarding a design partner). Runs on the migrator connection because the app role
 * cannot create tenants. The owner starts as an invite: their first WorkOS sign-in in `workosOrgId` activates it
 * (activate_workos_invite), or a dev sign-in outside production.
 */
export async function createTenant(pool: Pool, t: NewTenant): Promise<{ tenantId: string; ownerId: string }> {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(t.slug)) throw new Error("slug: 2–41 chars, a-z, 0-9 and -");
  const email = t.owner.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("owner email is not valid");
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO abcrm.tenants(id, name, slug, plan, country, workos_org_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [tenantId, t.name, t.slug, t.plan ?? "trial", t.country ?? null, t.workosOrgId ?? null]);
    await client.query(
      `INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, name, role, timezone, status, invited_at)
       VALUES ($1, $2, $3, $4, $5, 'owner', $6, 'invited', now())`,
      [ownerId, tenantId, `invite:${ownerId}`, email, t.owner.name ?? null, t.owner.timezone ?? "Asia/Ho_Chi_Minh"]);
    await client.query("INSERT INTO abcrm.outbox(id, tenant_id, topic, payload) VALUES ($1, $2, 'iam.tenant.created', $3)",
      [randomUUID(), tenantId, { plan: t.plan ?? "trial" }]);
    await client.query("COMMIT");
    return { tenantId, ownerId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
