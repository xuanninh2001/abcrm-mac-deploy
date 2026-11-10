import { Hono } from "hono";
import { z } from "zod";
import { getAgent, listAgents, setAgentStatus, setKillSwitch, updateAgentBudgets } from "@abcrm/agents";
import { updateUsageSettings, usageSummary } from "@abcrm/core";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, requirePermission } from "./util.js";

/** Agents (guardrails), usage & spend caps, kill switch (api.md §2.1, §2.6). */
export function agentRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get("/agents", async (c) => {
    requirePermission(c, "crm.read");
    return c.json({ data: await inTenant(deps, c, listAgents) });
  });
  r.get("/agents/:id", async (c) => {
    requirePermission(c, "crm.read");
    return c.json(await inTenant(deps, c, (tx) => getAgent(tx, c.req.param("id"))));
  });
  r.patch("/agents/:id", async (c) => {
    requirePermission(c, "agents.manage");
    const b = z.object({ credit_budget_daily: z.number().int().min(1).max(1_000_000).nullable().optional(),
      credit_budget_monthly: z.number().int().min(1).max(10_000_000).nullable().optional() }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => updateAgentBudgets(tx, c.req.param("id"), { daily: b.credit_budget_daily, monthly: b.credit_budget_monthly })));
  });
  for (const op of ["pause", "resume"] as const) {
    r.post(`/agents/:id/${op}`, async (c) => {
      requirePermission(c, "agents.manage");
      return c.json(await inTenant(deps, c, (tx) => setAgentStatus(tx, c.req.param("id"), op)));
    });
  }

  r.get("/usage", async (c) => {
    requirePermission(c, "crm.read");
    return c.json(await inTenant(deps, c, usageSummary));
  });
  r.patch("/usage/settings", async (c) => {
    requirePermission(c, "billing.manage");
    const b = z.object({ meter: z.enum(["agent", "contact"]), overage_enabled: z.boolean().optional(),
      spend_cap_usd: z.number().min(0).max(1_000_000).nullable().optional() }).parse(await c.req.json());
    return c.json({ data: await inTenant(deps, c, (tx) => updateUsageSettings(tx, { meter: b.meter, overageEnabled: b.overage_enabled, spendCapUsd: b.spend_cap_usd })) });
  });

  r.post("/tenant/kill-switch", async (c) => {
    requirePermission(c, "billing.manage");   // owner/admin only
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => setKillSwitch(tx, enabled)));
  });
  return r;
}
