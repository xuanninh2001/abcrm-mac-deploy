import { Hono } from "hono";
import { getSupplyProfiles, saveSupplyDraft, submitSupplyDraft, SupplyProfileInput } from "@abcrm/setup";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, requirePermission } from "./util.js";

export function setupRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.get("/supply-profile", async (c) => c.json(await inTenant(deps, c, getSupplyProfiles)));
  r.put("/supply-profile/draft", async (c) => {
    requirePermission(c, "setup.supply.write");
    const input = SupplyProfileInput.parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => saveSupplyDraft(tx, c.get("ctx").actor, input)));
  });
  r.post("/supply-profile/draft/submit", async (c) => {
    requirePermission(c, "setup.supply.write");
    return c.json(await inTenant(deps, c, (tx) => submitSupplyDraft(tx, c.get("ctx").actor)), 201);
  });
  return r;
}
