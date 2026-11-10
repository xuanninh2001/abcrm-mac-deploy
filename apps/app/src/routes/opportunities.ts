import { Hono } from "hono";
import { z } from "zod";
import { createOpportunity, getOpportunity, listOpportunities, OPPORTUNITY_STAGES, updateOpportunity } from "@abcrm/crm";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, requirePermission } from "./util.js";

const Create = z.object({ account_id: z.uuid(), owner_user_id: z.uuid().optional(), expected_monthly_value: z.number().nonnegative().optional(), next_step: z.string().max(500).optional() });
const Patch = z.object({
  stage: z.enum(OPPORTUNITY_STAGES), owner_user_id: z.uuid().nullable(), expected_monthly_value: z.number().nonnegative().nullable(),
  next_step: z.string().max(500).nullable(), close_date: z.iso.date().nullable(), lost_reason: z.string().max(200).nullable(),
}).partial().strict();

export function opportunityRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.get("/", async (c) => c.json({ data: await inTenant(deps, c, (tx) => listOpportunities(tx, { accountId: c.req.query("account_id"), stage: c.req.query("stage") })) }));
  r.get("/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getOpportunity(tx, c.req.param("id")))));
  r.post("/", async (c) => {
    requirePermission(c, "crm.write");
    const b = Create.parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => createOpportunity(tx, c.get("ctx").actor, {
      accountId: b.account_id, ownerUserId: b.owner_user_id, expectedMonthlyValue: b.expected_monthly_value, nextStep: b.next_step })), 201);
  });
  r.patch("/:id", async (c) => {
    requirePermission(c, "crm.write");
    const p = Patch.parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => updateOpportunity(tx, c.get("ctx").actor, c.req.param("id"), p)));
  });
  return r;
}
