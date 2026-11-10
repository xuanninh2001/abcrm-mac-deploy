import { Hono } from "hono";
import { z } from "zod";
import { controlRun, createRun, estimateRun, getRun, listCandidates, listRuns } from "@abcrm/sourcing";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, pageLimit, requirePermission } from "./util.js";

const Estimate = z.object({ target_count: z.number().int().min(1).max(5000) });
const Create = Estimate.extend({
  ipp_id: z.uuid(),
  agent_credit_budget: z.number().int().min(1).max(1_000_000).optional(),
  contact_credit_budget: z.number().int().min(0).max(100_000).optional(),
});

export function sourcingRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.post("/estimate", async (c) => c.json(estimateRun(Estimate.parse(await c.req.json()).target_count)));

  /** Runs above the approval threshold wait for G-T1 (setup lane); smaller ones are queued immediately. */
  r.post("/", async (c) => {
    requirePermission(c, "sourcing.run.start");
    const b = Create.parse(await c.req.json());
    const est = estimateRun(b.target_count);
    const run = await inTenant(deps, c, (tx) => createRun(tx, c.get("ctx").actor, {
      ippId: b.ipp_id, targetCount: b.target_count,
      agentCreditBudget: b.agent_credit_budget ?? Math.ceil(est.agent_credits * 1.5),
      contactCreditBudget: b.contact_credit_budget ?? est.contact_credits,
    }));
    return c.json(run, 201);
  });

  r.get("/", async (c) => c.json({ data: await inTenant(deps, c, listRuns) }));
  r.get("/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getRun(tx, c.req.param("id")))));
  r.get("/:id/candidates", async (c) => c.json({
    data: await inTenant(deps, c, (tx) => listCandidates(tx, c.req.param("id"), { status: c.req.query("status"), limit: pageLimit(c) })),
  }));
  for (const op of ["pause", "resume", "cancel"] as const) {
    r.post(`/:id/${op}`, async (c) => {
      requirePermission(c, "sourcing.run.start");
      return c.json(await inTenant(deps, c, (tx) => controlRun(tx, c.get("ctx").actor, c.req.param("id"), op)));
    });
  }
  return r;
}
