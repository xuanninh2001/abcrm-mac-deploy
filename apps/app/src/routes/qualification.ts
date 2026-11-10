import { Hono } from "hono";
import { z } from "zod";
import { createAccount } from "@abcrm/crm";
import { getLookup, requestLookup } from "@abcrm/contactdata";
import { createManualCandidate, getPreview, getScorecard, listAccountScorecards, listPreviews, loadPlaybook, requestPreview } from "@abcrm/qualification";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, requirePermission } from "./util.js";

/** Qualification (scorecards, playbook preview, manual candidates) and contact lookups. */
export function qualificationRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post("/playbooks/:id/preview", async (c) => {
    requirePermission(c, "setup.playbook.write");
    const body = z.object({ sample: z.enum(["recent", "golden"]).default("recent"), size: z.number().int().min(1).max(20).default(10) })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await inTenant(deps, c, (tx) => requestPreview(tx, c.get("ctx").actor, c.req.param("id"), body)), 202);
  });
  r.get("/playbooks/:id/previews", async (c) => c.json({ data: await inTenant(deps, c, async (tx) => {
    await loadPlaybook(tx, c.req.param("id"));
    return listPreviews(tx, c.req.param("id"));
  }) }));
  r.get("/playbook-previews/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getPreview(tx, c.req.param("id")))));

  r.get("/accounts/:id/scorecards", async (c) => c.json({ data: await inTenant(deps, c, (tx) => listAccountScorecards(tx, c.req.param("id"))) }));
  r.get("/scorecards/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getScorecard(tx, c.req.param("id")))));

  r.post("/accounts/:id/contacts/find", async (c) => {
    requirePermission(c, "contactdata.lookup");
    const body = z.object({ titles: z.array(z.string().max(120)).max(10).optional(), limit: z.number().int().min(1).max(5).default(2) }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => requestLookup(tx, c.get("ctx").actor, { accountId: c.req.param("id"), ...body })), 202);
  });
  r.get("/contact-lookups/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getLookup(tx, c.req.param("id")))));

  r.post("/candidates/manual", async (c) => {
    requirePermission(c, "crm.write");
    const body = z.object({ domain: z.string().min(3).max(253), name: z.string().max(200).optional(), note: z.string().max(500).optional() }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, async (tx) => {
      const { account } = await createAccount(tx, deps.keyring, c.get("ctx").actor, { name: body.name ?? body.domain, domain: body.domain }, "return");
      const { candidateId } = await createManualCandidate(tx, c.get("ctx").actor, account.id, body.note);
      return { candidate_id: candidateId, account_id: account.id, status: "found" };
    }), 201);
  });
  return r;
}
