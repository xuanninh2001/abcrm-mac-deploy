import { Hono } from "hono";
import { z } from "zod";
import { Problem } from "@abcrm/core";
import {
  approveMapping, commitImport, dryRun, getImportJob, ImportFileError, listImportJobs, listImportRows, parseFile, rollbackImport, stageImport, TARGETS,
  type Purpose, type TargetField,
} from "@abcrm/importer";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, pageLimit, requirePermission } from "./util.js";

const MAX_BYTES = 20 * 1024 * 1024;
const PURPOSES = Object.keys(TARGETS) as [Purpose, ...Purpose[]];
const ALL_TARGETS = [...new Set(Object.values(TARGETS).flatMap((t) => t.fields))] as [TargetField, ...TargetField[]];
const Mapping = z.object({ field_map: z.array(z.object({ source: z.string().min(1), target: z.enum(ALL_TARGETS), confidence: z.number().min(0).max(1).default(1) })).max(50) });

export function importRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => { requirePermission(c, "import.run"); await next(); });

  r.post("/", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_BYTES) throw new Problem("validation-failed", "File too large (max 20 MB)");
    const form = await c.req.parseBody();
    const file = form.file;
    const purpose = z.enum(PURPOSES).parse(form.purpose);
    if (!(file instanceof File)) throw new Problem("validation-failed", "Missing file");
    if (file.size > MAX_BYTES) throw new Problem("validation-failed", "File too large (max 20 MB)");
    let sheets;
    try { sheets = await parseFile(Buffer.from(await file.arrayBuffer()), file.name); }
    catch (err) { if (err instanceof ImportFileError) throw new Problem("validation-failed", err.message); throw err; }
    const res = await inTenant(deps, c, (tx) => stageImport(tx, c.get("ctx").actor, {
      purpose, filename: file.name, source: file.name.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv", sheets,
      sheetName: typeof form.sheet === "string" ? form.sheet : undefined,
    }));
    return c.json(res, 201);
  });

  r.get("/", async (c) => c.json({ data: await inTenant(deps, c, (tx) => listImportJobs(tx, { limit: pageLimit(c) })) }));
  // `targets` lets the UI offer the purpose's fields and flag missing required ones before saving.
  r.get("/:id", async (c) => {
    const job = await inTenant(deps, c, (tx) => getImportJob(tx, c.req.param("id")));
    return c.json({ ...job, targets: TARGETS[job.purpose as Purpose] });
  });
  r.get("/:id/rows", async (c) => c.json({ data: await inTenant(deps, c, (tx) => listImportRows(tx, c.req.param("id"), { status: c.req.query("status"), limit: pageLimit(c) })) }));

  r.put("/:id/mapping", async (c) => {
    const { field_map } = Mapping.parse(await c.req.json());
    await inTenant(deps, c, (tx) => approveMapping(tx, c.get("ctx").actor, c.req.param("id"), field_map));
    return c.json(await inTenant(deps, c, (tx) => getImportJob(tx, c.req.param("id"))));
  });
  r.post("/:id/dry-run", async (c) => c.json(await inTenant(deps, c, (tx) => dryRun(tx, c.req.param("id")))));
  r.post("/:id/commit", async (c) => c.json(await inTenant(deps, c, (tx) => commitImport(tx, deps.keyring, c.get("ctx").actor, c.req.param("id")))));
  r.post("/:id/rollback", async (c) => c.json(await inTenant(deps, c, (tx) => rollbackImport(tx, c.get("ctx").actor, c.req.param("id")))));
  return r;
}
