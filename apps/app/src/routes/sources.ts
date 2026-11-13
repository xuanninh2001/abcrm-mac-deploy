import { Hono } from "hono";
import { z } from "zod";
import { Problem, readSourceSettings, saveSourceSettings, sourceCredential } from "@abcrm/core";
import { BraveSearch, TavilySearch } from "@abcrm/sourcing";
import { HunterContactProvider } from "@abcrm/contactdata";
import type { AppEnv, Deps } from "../env.js";
import { inTenant } from "./util.js";

const providerSchema = z.enum(["brave", "tavily", "hunter"]);
const inputSchema = z.object({ enabled: z.boolean(), priority: z.number().int().min(1).max(100),
  apiKey: z.string().trim().max(4096).optional(), clearKey: z.boolean().default(false), usageAllowed: z.boolean().default(false) });
export function sourceRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    if (c.get("ctx").role !== "owner") throw new Problem("permission-denied", "Only the workspace owner can manage sources.");
    await next();
  });
  r.get("/", async c => c.json(await inTenant(deps, c, readSourceSettings)));
  r.put("/:provider", async c => {
    const provider = providerSchema.parse(c.req.param("provider"));
    const input = inputSchema.parse(await c.req.json());
    return c.json(await inTenant(deps, c, tx => saveSourceSettings(tx, deps.keyring, provider, input)));
  });
  r.post("/:provider/test", async c => {
    const provider = providerSchema.parse(c.req.param("provider"));
    const input = inputSchema.parse(await c.req.json());
    const key = await inTenant(deps, c, tx => sourceCredential(tx, deps.keyring, provider, input));
    if (!key) throw new Problem("validation-failed", "Enter an API key to test this source.");
    const started = Date.now();
    try {
      if (provider === "hunter") await new HunterContactProvider(key).test();
      else await (provider === "brave" ? new BraveSearch(key) : new TavilySearch(key)).search({ query: "example.com", limit: 1 });
      return c.json({ ok: true, latencyMs: Date.now() - started, message: provider === "hunter" ? "Account authentication succeeded. Domain-search access and results depend on your plan." : "Search request succeeded." });
    } catch (error) { throw new Problem("validation-failed", error instanceof Error ? error.message : "Source test failed."); }
  });
  return r;
}
