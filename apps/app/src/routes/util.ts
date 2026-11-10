import type { Context } from "hono";
import { Problem } from "@abcrm/core";
import { withTenant, type TenantTx } from "@abcrm/db";
import { hasPermission, type Permission } from "@abcrm/agents";
import type { AppEnv, Deps } from "../env.js";

export function requirePermission(c: Context<AppEnv>, perm: Permission): void {
  if (!hasPermission(c.get("principal"), perm)) throw new Problem("permission-denied", `${perm} required`);
}

/** Runs fn in the caller's tenant transaction. */
export function inTenant<T>(deps: Deps, c: Context<AppEnv>, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const { tenantId, actor } = c.get("ctx");
  return withTenant(deps.pool, tenantId, actor, fn);
}

export const pageLimit = (c: Context<AppEnv>) => Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
