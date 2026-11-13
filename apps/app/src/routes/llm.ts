import { Hono } from "hono";
import { z } from "zod";
import { Problem } from "@abcrm/core";
import { prepareLlmSettings, readLlmSettings, saveLlmSettings, settingsSchema, RouterGateway } from "@abcrm/llm";
import type { AppEnv, Deps } from "../env.js";
import { inTenant } from "./util.js";

export function llmRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    if (c.get("ctx").role !== "owner") throw new Problem("permission-denied", "Only the workspace owner can configure LLM access.");
    await next();
  });
  r.get("/", async c => c.json(await inTenant(deps, c, readLlmSettings)));
  r.put("/", async c => {
    const input = settingsSchema.parse(await c.req.json());
    return c.json(await inTenant(deps, c, tx => saveLlmSettings(tx, deps.keyring, input)));
  });
  for (const action of ["models", "test"] as const) {
    r.post(`/${action}`, async c => {
      const input = settingsSchema.parse(await c.req.json());
      if (input.mode !== "9router") throw new Problem("validation-failed", "Select 9router to test this connection.");
      const options = await inTenant(deps, c, tx => prepareLlmSettings(tx, deps.keyring, { ...input, model: input.model || (action === "models" ? "list-models" : "") }));
      const gateway = new RouterGateway(options);
      try {
        if (action === "models") return c.json({ models: await gateway.models() });
        const start = Date.now();
        const result = await gateway.generate({ tier: "small", purpose: "connection-test", system: ["You are testing an API connection."],
          user: 'Return {"ok":true}', schema: z.object({ ok: z.literal(true) }), maxTokens: 512 });
        return c.json({ ok: true, model: result.usage.model, latencyMs: Date.now() - start, usage: result.usage });
      } catch (error) {
        // Transport and gateway errors deliberately exclude upstream bodies and credentials.
        throw new Problem("validation-failed", error instanceof Error ? error.message : "9router connection failed.");
      }
    });
  }
  return r;
}
