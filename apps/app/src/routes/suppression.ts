import { Hono } from "hono";
import { z } from "zod";
import { addSuppression, listSuppression, removeSuppression } from "@abcrm/crm";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, pageLimit, requirePermission } from "./util.js";

const Add = z.object({
  kind: z.enum(["email", "domain"]), value: z.string().min(3).max(254),
  reason: z.enum(["unsubscribe", "bounce", "complaint", "dsar", "manual", "competitor", "existing_buyer"]).default("manual"),
});

export function suppressionRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.get("/", async (c) => {
    requirePermission(c, "crm.write");   // values are PII: not for viewers
    const kind = c.req.query("kind");
    return c.json(await inTenant(deps, c, (tx) => listSuppression(tx, deps.keyring, {
      limit: pageLimit(c), cursor: c.req.query("cursor"), kind: kind === "email" || kind === "domain" ? kind : undefined })));
  });
  r.post("/", async (c) => {
    requirePermission(c, "crm.write");
    const b = Add.parse(await c.req.json());
    const res = await inTenant(deps, c, (tx) => addSuppression(tx, deps.keyring, c.get("ctx").actor, b));
    return c.json(res, res.created ? 201 : 200);
  });
  r.delete("/:id", async (c) => {
    requirePermission(c, "compliance.manage");
    await inTenant(deps, c, (tx) => removeSuppression(tx, c.get("ctx").actor, c.req.param("id")));
    return c.body(null, 204);
  });
  return r;
}
