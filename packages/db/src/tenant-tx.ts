import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "./pool.js";
import * as schema from "./schema.js";

declare const tenantTxBrand: unique symbol;

/** A transaction with app.tenant_id set. Repositories only accept this type. */
export type TenantTx = {
  readonly tenantId: string;
  readonly client: PoolClient;
  readonly db: NodePgDatabase<typeof schema>;
  readonly [tenantTxBrand]: true;
};

export type Actor =
  | { type: "user"; id: string }
  | { type: "agent"; id: string }
  | { type: "api_key"; id: string }
  | { type: "system"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs fn inside a transaction scoped to one tenant. RLS reads app.tenant_id, which is
 * transaction-local (set_config(..., true)), so it is safe with transaction-mode poolers.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  actor: Actor,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("withTenant: invalid tenant id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.actor', $2, true)", [
      tenantId,
      `${actor.type}:${actor.id}`,
    ]);
    const tx = { tenantId, client, db: drizzle(client, { schema }) } as unknown as TenantTx;
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
