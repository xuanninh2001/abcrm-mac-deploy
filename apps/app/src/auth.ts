import { createHash, randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Problem, runWithContext } from "@abcrm/core";
import { withTenant } from "@abcrm/db";
import type { Principal, Role } from "@abcrm/agents";
import type { AppEnv, Deps } from "./env.js";
import { recordActivation } from "./iam.js";
import { clientIp, RateLimiter, tooMany } from "./limits.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the caller to (tenant, principal). Supported: API keys (`abk_…`), WorkOS access tokens
 * (JWT) and, outside production, dev tokens (`dev:<tenantId>:<userId>`).
 */
export function authenticate(deps: Deps, failures: RateLimiter): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Guessing API keys or replaying tokens: an address with too many failed attempts is refused for a while.
    const ip = clientIp(c);
    const blocked = failures.blocked(ip);
    if (blocked) { c.header("retry-after", String(blocked)); throw tooMany(blocked); }
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    let tenantId: string | undefined;
    let principal: Principal | undefined;
    let actor: { type: "user" | "api_key"; id: string } | undefined;
    let scopes: string[] | undefined;

    if (token.startsWith("abk_")) {
      const hash = createHash("sha256").update(token).digest();
      const { rows: [k] } = await deps.pool.query<{ api_key_id: string; tenant_id: string; scopes: string[] }>(
        "SELECT * FROM abcrm.resolve_api_key($1)", [hash]);
      if (k) {
        tenantId = k.tenant_id;
        scopes = k.scopes;
        actor = { type: "api_key", id: k.api_key_id };
        principal = { type: "user", id: k.api_key_id, role: "viewer" };   // API keys get read-only until scopes are mapped (Phase 1)
      }
    } else if (deps.devAuth && token.startsWith("dev:")) {
      const [, t, u] = token.split(":");
      if (t && u && UUID.test(t) && UUID.test(u)) {
        // An invited user's first dev sign-in activates them, like a first WorkOS sign-in does.
        const user = await withTenant(deps.pool, t, { type: "system", id: "auth" }, async (tx) => {
          const { rows: [row] } = await tx.client.query<{ id: string; role: Role; status: string }>(
            "SELECT id, role, status FROM abcrm.users WHERE id = $1 AND status IN ('active', 'invited')", [u]);
          if (row?.status === "invited") {
            await tx.client.query("UPDATE abcrm.users SET status = 'active', activated_at = now() WHERE id = $1", [u]);
            await recordActivation(tx, u);
          }
          return row;
        });
        if (user) {
          tenantId = t;
          actor = { type: "user", id: user.id };
          principal = { type: "user", id: user.id, role: user.role };
        }
      }
    } else if (deps.verifier && token.split(".").length === 3) {
      const session = await deps.verifier.verify(token);
      if (session) {
        let { rows: [u] } = await deps.pool.query<{ tenant_id: string; user_id: string; role: Role }>(
          "SELECT * FROM abcrm.resolve_workos_identity($1, $2)", [session.orgId, session.userId]);
        // First sign-in of an invited user: bind the WorkOS identity to the invite with the same verified email.
        if (!u && deps.directory) {
          const email = await deps.directory.verifiedEmail(session.userId);
          if (email) {
            ({ rows: [u] } = await deps.pool.query<{ tenant_id: string; user_id: string; role: Role }>(
              "SELECT * FROM abcrm.activate_workos_invite($1, $2, $3)", [session.orgId, session.userId, email]));
            if (u) await withTenant(deps.pool, u.tenant_id, { type: "user", id: u.user_id }, (tx) => recordActivation(tx, u!.user_id));
          }
        }
        if (u) {
          tenantId = u.tenant_id;
          actor = { type: "user", id: u.user_id };
          principal = { type: "user", id: u.user_id, role: u.role };
        }
      }
    }

    if (!tenantId || !principal || !actor) {
      failures.hit(ip);
      throw new Problem("unauthenticated", "Authentication required");
    }
    const ctx = { requestId, tenantId, actor, role: principal.type === "user" ? principal.role : undefined, scopes };
    c.set("ctx", ctx);
    c.set("principal", principal);
    c.header("x-request-id", requestId);
    await runWithContext(ctx, next);
  };
}
