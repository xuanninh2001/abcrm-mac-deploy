import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Deps } from "./env.js";
import { authenticate } from "./auth.js";
import { actorLimit, DEFAULT_LIMITS, RateLimiter } from "./limits.js";
import { onError } from "./errors.js";
import { accountRoutes } from "./routes/accounts.js";
import { contactRoutes } from "./routes/contacts.js";
import { opportunityRoutes } from "./routes/opportunities.js";
import { suppressionRoutes } from "./routes/suppression.js";
import { setupRoutes } from "./routes/setup.js";
import { decisionRoutes } from "./routes/decisions.js";
import { importRoutes } from "./routes/imports.js";
import { targetingRoutes } from "./routes/targeting.js";
import { sourcingRoutes } from "./routes/sourcing.js";
import { qualificationRoutes } from "./routes/qualification.js";
import { cardRoutes } from "./routes/cards.js";
import { agentRoutes } from "./routes/agents.js";
import { notificationRoutes } from "./routes/notifications.js";
import { userRoutes } from "./routes/users.js";
import { Problem } from "@abcrm/core";
import { withTenant } from "@abcrm/db";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-site" }));
  // JSON bodies are small; only file uploads (POST /v1/imports, ≤ 20 MB) may be larger.
  const tooLarge = () => { throw new Problem("validation-failed", "Request body too large"); };
  app.use("*", async (c, next) => {
    const upload = c.req.method === "POST" && c.req.path === "/v1/imports";
    return bodyLimit({ maxSize: upload ? 21 * 1024 * 1024 : 1024 * 1024, onError: tooLarge })(c, next);
  });
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  app.notFound((c) => {
    const p = new Problem("not-found", "Route not found");
    return c.json(p.toJSON(c.req.path), 404, { "content-type": "application/problem+json" });
  });

  app.get("/healthz", async (c) => {
    await deps.pool.query("SELECT 1");
    return c.json({ ok: true });
  });

  const v1 = new Hono<AppEnv>();
  v1.use("*", authenticate(deps, new RateLimiter(limits.authFailuresPerIpPerMin)));
  v1.use("*", actorLimit(new RateLimiter(limits.perActorPerMin)));
  v1.get("/me", async (c) => {
    const { tenantId, actor, role } = c.get("ctx");
    const user = actor.type === "user"
      ? await withTenant(deps.pool, tenantId, actor, async (tx) => (await tx.client.query(
        "SELECT id, name, email, timezone, working_hours, locale FROM abcrm.users WHERE id = $1", [actor.id])).rows[0] ?? null)
      : null;
    return c.json({ tenant_id: tenantId, actor, role, user });
  });
  v1.route("/users", userRoutes(deps));
  v1.route("/accounts", accountRoutes(deps));
  v1.route("/contacts", contactRoutes(deps));
  v1.route("/opportunities", opportunityRoutes(deps));
  v1.route("/suppression", suppressionRoutes(deps));
  v1.route("/decisions", decisionRoutes(deps));
  v1.route("/imports", importRoutes(deps));
  v1.route("/", setupRoutes(deps));
  v1.route("/", targetingRoutes(deps));
  v1.route("/", qualificationRoutes(deps));
  v1.route("/cards", cardRoutes(deps));
  v1.route("/", agentRoutes(deps));
  v1.route("/notifications", notificationRoutes(deps));
  v1.route("/sourcing-runs", sourcingRoutes(deps));

  app.route("/v1", v1);
  return app;
}
