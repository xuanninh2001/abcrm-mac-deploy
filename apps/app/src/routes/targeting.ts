import { Hono } from "hono";
import { z } from "zod";
import { Problem } from "@abcrm/core";
import {
  cloneFromPack, getIpp, getPlaybook, IppInput, listIpps, listPacks, listPlaybooks, loadPack, PlaybookInput, saveIppDraft,
  savePlaybookDraft, submitIpp, submitPlaybook,
} from "@abcrm/setup";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, requirePermission } from "./util.js";

/** Vertical packs, playbooks and IPPs: who to look for and how to qualify them. */
export function targetingRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get("/vertical-packs", async (c) => c.json({ data: await listPacks() }));
  r.get("/vertical-packs/:key", async (c) => {
    const p = await loadPack(c.req.param("key"));
    return c.json({ key: p.key, version: p.version, taxonomy: p.taxonomy, signals: p.signals, contact_titles: p.contact_titles,
      ipp_templates: p.ipp_templates.map((t) => t.name), playbook_templates: Object.keys(p.playbook_templates) });
  });
  r.post("/vertical-packs/:key/clone", async (c) => {
    requirePermission(c, "setup.ipp.write");
    requirePermission(c, "setup.playbook.write");
    const { ipp_template } = z.object({ ipp_template: z.string().min(1) }).parse(await c.req.json());
    const res = await inTenant(deps, c, (tx) => cloneFromPack(tx, c.get("ctx").actor, c.req.param("key"), ipp_template));
    return c.json(res, 201);
  });

  r.get("/playbooks", async (c) => c.json({ data: await inTenant(deps, c, listPlaybooks) }));
  r.get("/playbooks/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getPlaybook(tx, c.req.param("id")))));
  r.post("/playbooks", async (c) => {
    requirePermission(c, "setup.playbook.write");
    const input = PlaybookInput.parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => savePlaybookDraft(tx, c.get("ctx").actor, input)), 201);
  });
  /** PUT updates a draft; POST /versions starts a new draft from an active/archived version of the same lineage. */
  r.put("/playbooks/:id", async (c) => {
    requirePermission(c, "setup.playbook.write");
    const input = PlaybookInput.parse(await c.req.json());
    return c.json(await inTenant(deps, c, async (tx) => {
      const p = await getPlaybook(tx, c.req.param("id"));
      if (p.status !== "draft") throw new Problem("conflict", `Playbook is ${p.status}; create a new version instead`);
      return savePlaybookDraft(tx, c.get("ctx").actor, input, p.lineage_id);
    }));
  });
  r.post("/playbooks/:id/versions", async (c) => {
    requirePermission(c, "setup.playbook.write");
    const input = PlaybookInput.parse(await c.req.json());
    return c.json(await inTenant(deps, c, async (tx) => {
      const p = await getPlaybook(tx, c.req.param("id"));
      return savePlaybookDraft(tx, c.get("ctx").actor, input, p.lineage_id);
    }), 201);
  });
  r.post("/playbooks/:id/submit", async (c) => {
    requirePermission(c, "setup.playbook.write");
    return c.json(await inTenant(deps, c, (tx) => submitPlaybook(tx, c.get("ctx").actor, c.req.param("id"))), 201);
  });

  r.get("/ipps", async (c) => c.json({ data: await inTenant(deps, c, listIpps) }));
  r.get("/ipps/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getIpp(tx, c.req.param("id")))));
  r.post("/ipps", async (c) => {
    requirePermission(c, "setup.ipp.write");
    const input = IppInput.parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => saveIppDraft(tx, c.get("ctx").actor, input)), 201);
  });
  r.put("/ipps/:id", async (c) => {
    requirePermission(c, "setup.ipp.write");
    const input = IppInput.parse(await c.req.json());
    return c.json(await inTenant(deps, c, async (tx) => {
      const i = await getIpp(tx, c.req.param("id"));
      if (i.status !== "draft") throw new Problem("conflict", `IPP is ${i.status}; create a new version instead`);
      return saveIppDraft(tx, c.get("ctx").actor, input, i.lineage_id);
    }));
  });
  r.post("/ipps/:id/versions", async (c) => {
    requirePermission(c, "setup.ipp.write");
    const input = IppInput.parse(await c.req.json());
    return c.json(await inTenant(deps, c, async (tx) => saveIppDraft(tx, c.get("ctx").actor, input, (await getIpp(tx, c.req.param("id"))).lineage_id)), 201);
  });
  r.post("/ipps/:id/submit", async (c) => {
    requirePermission(c, "setup.ipp.write");
    return c.json(await inTenant(deps, c, (tx) => submitIpp(tx, c.get("ctx").actor, c.req.param("id"))), 201);
  });
  return r;
}
