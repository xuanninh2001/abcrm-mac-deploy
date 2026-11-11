import type { Pool } from "./pool.js";

/** Administrative connection only. Preserve existing identity and role when migrating from SSO. */
export async function setLocalPassword(pool: Pool, slug: string, email: string, hash: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [user] } = await client.query(
      `SELECT u.id,u.status FROM abcrm.users u JOIN abcrm.tenants t ON t.id=u.tenant_id
       WHERE t.slug=$1 AND lower(u.email)=lower($2) AND t.status='active' FOR UPDATE OF u`, [slug,email]);
    if (!user) throw new Error("No user in this active workspace. Create the account first.");
    if (user.status === "disabled") throw new Error("Enable the user through Team before resetting their password.");
    await client.query(`INSERT INTO abcrm.local_credentials(user_id,password_hash) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=now()`, [user.id,hash]);
    await client.query("DELETE FROM abcrm.local_sessions WHERE user_id=$1", [user.id]);
    await client.query("UPDATE abcrm.users SET status='active',activated_at=coalesce(activated_at,now()) WHERE id=$1", [user.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
