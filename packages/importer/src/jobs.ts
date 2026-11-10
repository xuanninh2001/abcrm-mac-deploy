import { createHash } from "node:crypto";
import type { Actor, TenantTx } from "@abcrm/db";
import { appendAudit, canonicalJson, emit, notFound, Problem, uuidv7, type TenantKeyring } from "@abcrm/core";
import { addSuppression, createAccount, createContact, setAccountFlags } from "@abcrm/crm";
import { missingRequired, proposeMapping, type FieldMapEntry, type Purpose } from "./mapping.js";
import type { Sheet } from "./parse.js";
import { applyMapping, validateRow, type Normalized, type RowStatus } from "./validate.js";

export type JobStatus = "staged" | "mapping" | "dry_run" | "ready" | "committing" | "committed" | "rolled_back" | "failed";
export type DryRunStats = { rows: number; valid: number; warning: number; error: number; duplicate_in_file: number };


async function getJob(tx: TenantTx, id: string) {
  const { rows: [j] } = await tx.client.query<{ id: string; purpose: Purpose; status: JobStatus; mapping_id: string | null; stats: Record<string, unknown>; filename: string | null; committed_at: Date | null }>(
    "SELECT id, purpose, status, mapping_id, stats, filename, committed_at FROM abcrm.import_jobs WHERE id = $1 FOR UPDATE", [id]);
  if (!j) throw notFound("Import job");
  return j;
}

/** Stages parsed rows and proposes a mapping. `sheetName` picks one sheet of a workbook (default: first). */
export async function stageImport(
  tx: TenantTx, actor: Actor, input: { purpose: Purpose; filename: string; source: "csv" | "xlsx"; sheets: Sheet[]; sheetName?: string },
) {
  const sheet = input.sheetName ? input.sheets.find((s) => s.name === input.sheetName) : input.sheets[0];
  if (!sheet) throw new Problem("validation-failed", `Sheet not found: ${input.sheetName}`);
  if (sheet.rows.length === 0) throw new Problem("validation-failed", "The file has no data rows");
  const jobId = uuidv7();
  const createdBy = actor.type === "user" ? actor.id : null;
  const fieldMap = proposeMapping(sheet.headers, input.purpose);
  const mappingId = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.import_mappings(id, tenant_id, source, version, object_map, field_map) VALUES ($1, $2, $3, 1, $4, $5)`,
    [mappingId, tx.tenantId, input.source, { purpose: input.purpose, sheet: sheet.name, headers: sheet.headers }, JSON.stringify(fieldMap)]);
  await tx.client.query(
    `INSERT INTO abcrm.import_jobs(id, tenant_id, source, purpose, status, mapping_id, filename, stats, created_by)
     VALUES ($1, $2, $3, $4, 'mapping', $5, $6, $7, $8)`,
    [jobId, tx.tenantId, input.source, input.purpose, mappingId, input.filename, { rows: sheet.rows.length, sheets: input.sheets.map((s) => s.name) }, createdBy]);

  // Bulk insert staging rows in chunks (unnest keeps it to one round trip per chunk).
  for (let i = 0; i < sheet.rows.length; i += 1000) {
    const chunk = sheet.rows.slice(i, i + 1000);
    await tx.client.query(
      `INSERT INTO abcrm.import_staging_rows(tenant_id, job_id, row_no, source_object, raw, row_hash)
       SELECT $1, $2, n, $3, r, h FROM unnest($4::int[], $5::jsonb[], $6::bytea[]) AS t(n, r, h)`,
      [tx.tenantId, jobId, sheet.name, chunk.map((_, k) => i + k + 2),   // +2: 1-based and header row → matches spreadsheet row numbers
        chunk.map((r) => JSON.stringify(r)), chunk.map((r) => createHash("sha256").update(canonicalJson(r)).digest())]);
  }
  await appendAudit(tx, { actor, action: "import.staged", subject: { type: "import_job", id: jobId } });
  await emit(tx, "import.job.staged", { job_id: jobId, rows: sheet.rows.length });
  return { jobId, mappingId, headers: sheet.headers, fieldMap, rows: sheet.rows.length };
}

/** A person confirms (or edits) the mapping. This is the "duyệt mapping" step of ADR-011. */
export async function approveMapping(tx: TenantTx, actor: Actor, jobId: string, fieldMap: FieldMapEntry[]) {
  const job = await getJob(tx, jobId);
  if (!["mapping", "dry_run", "ready"].includes(job.status)) throw new Problem("conflict", `Job is ${job.status}`);
  const { rows: [m] } = await tx.client.query<{ object_map: { headers: string[] } }>("SELECT object_map FROM abcrm.import_mappings WHERE id = $1", [job.mapping_id]);
  const unknown = fieldMap.filter((f) => !m!.object_map.headers.includes(f.source));
  if (unknown.length) throw new Problem("validation-failed", "Mapping references unknown columns", { columns: unknown.map((f) => f.source) });
  if (new Set(fieldMap.map((f) => f.target)).size !== fieldMap.length) throw new Problem("validation-failed", "Each field can be mapped once");
  const missing = missingRequired(fieldMap, job.purpose);
  if (missing) throw new Problem("validation-failed", "Required fields are not mapped", { one_of: missing });
  await tx.client.query("UPDATE abcrm.import_mappings SET field_map = $2, approved_by = $3, approved_at = now() WHERE id = $1",
    [job.mapping_id, JSON.stringify(fieldMap), actor.type === "user" ? actor.id : null]);
  await tx.client.query("UPDATE abcrm.import_jobs SET status = 'mapping' WHERE id = $1", [jobId]);   // mapping change invalidates a previous dry-run
}

/** Validates every row with the approved mapping and records per-row status; nothing is written to the CRM. */
export async function dryRun(tx: TenantTx, jobId: string): Promise<DryRunStats> {
  const job = await getJob(tx, jobId);
  if (!["mapping", "dry_run", "ready"].includes(job.status)) throw new Problem("conflict", `Job is ${job.status}`);
  const { rows: [m] } = await tx.client.query<{ field_map: FieldMapEntry[]; approved_at: Date | null }>(
    "SELECT field_map, approved_at FROM abcrm.import_mappings WHERE id = $1", [job.mapping_id]);
  if (!m?.approved_at) throw new Problem("conflict", "Approve the mapping before the dry-run");

  const stats: DryRunStats = { rows: 0, valid: 0, warning: 0, error: 0, duplicate_in_file: 0 };
  const seen = new Set<string>();
  const { rows } = await tx.client.query<{ row_no: number; raw: Record<string, string> }>(
    "SELECT row_no, raw FROM abcrm.import_staging_rows WHERE job_id = $1 ORDER BY row_no", [jobId]);
  const updates: { n: number; status: RowStatus; normalized: Normalized; errors: string[] }[] = [];
  for (const r of rows) {
    const res = validateRow(job.purpose, applyMapping(r.raw, m.field_map));
    let status: RowStatus = res.status;
    const messages = [...res.errors, ...res.warnings.map((w) => `warning: ${w}`)];
    if (status !== "error" && res.key) {
      if (seen.has(res.key)) { status = "skipped"; messages.push("duplicate of an earlier row in this file"); stats.duplicate_in_file++; }
      seen.add(res.key);
    }
    stats.rows++;
    if (status === "valid" || status === "warning" || status === "error") stats[status]++;
    updates.push({ n: r.row_no, status, normalized: res.normalized, errors: messages });
  }
  for (let i = 0; i < updates.length; i += 1000) {
    const chunk = updates.slice(i, i + 1000);
    await tx.client.query(
      `UPDATE abcrm.import_staging_rows s SET status = u.status, normalized = u.normalized, errors = u.errors
       FROM unnest($2::int[], $3::text[], $4::jsonb[], $5::jsonb[]) AS u(n, status, normalized, errors)
       WHERE s.job_id = $1 AND s.row_no = u.n`,
      [jobId, chunk.map((u) => u.n), chunk.map((u) => u.status), chunk.map((u) => JSON.stringify(u.normalized)), chunk.map((u) => JSON.stringify(u.errors))]);
  }
  await tx.client.query("UPDATE abcrm.import_jobs SET status = 'ready', stats = stats || $2 WHERE id = $1", [jobId, { dry_run: stats }]);
  await emit(tx, "import.job.dry_run_completed", { job_id: jobId, stats });
  return stats;
}

/** Writes valid/warning rows to the CRM. Idempotent per row: existing records are matched, not duplicated. */
export async function commitImport(tx: TenantTx, keyring: TenantKeyring, actor: Actor, jobId: string) {
  const job = await getJob(tx, jobId);
  if (job.status !== "ready") throw new Problem("conflict", job.status === "committed" ? "Already committed" : "Run a dry-run first");
  const source = { kind: "import", import_job_id: jobId };
  const counts = { created: 0, matched: 0, suppressed: 0 };
  const { rows } = await tx.client.query<{ row_no: number; normalized: Normalized }>(
    "SELECT row_no, normalized FROM abcrm.import_staging_rows WHERE job_id = $1 AND status IN ('valid', 'warning') ORDER BY row_no", [jobId]);

  for (const r of rows) {
    const n = r.normalized;
    let target: { type: string; id: string; created: boolean };
    switch (job.purpose) {
      case "accounts":
      case "existing_buyers": {
        const { account, created } = await createAccount(tx, keyring, actor, {
          name: n.company_name ?? n.company_domain!, domain: n.company_domain!, hqState: n.hq_state, hqCountry: n.hq_country,
          employeeRange: n.employee_range, verticals: n.verticals_list, source }, "return");
        if (job.purpose === "existing_buyers") await setAccountFlags(tx, actor, account.id, ["existing_buyer"], []);
        target = { type: "account", id: account.id, created };
        break;
      }
      case "contacts": {
        const { account } = await createAccount(tx, keyring, actor, { name: n.company_name ?? n.company_domain!, domain: n.company_domain!, hqState: n.hq_state, source }, "return");
        const { contact, created } = await createContact(tx, keyring, actor, account.id, {
          firstName: n.first_name, lastName: n.last_name, title: n.title, email: n.email, phone: n.phone, linkedinUrl: n.linkedin_url,
          source: { kind: "import", import_job_id: jobId } }, "return");
        target = { type: "contact", id: contact.id, created };
        break;
      }
      case "blocklist": {
        const res = await addSuppression(tx, keyring, actor, { kind: n.value!.includes("@") ? "email" : "domain", value: n.value!, reason: "import", source });
        counts.suppressed += res.contactsSuppressed;
        target = { type: "suppression", id: res.id, created: res.created };
        break;
      }
    }
    counts[target.created ? "created" : "matched"]++;
    await tx.client.query(
      "UPDATE abcrm.import_staging_rows SET status = 'committed', target_type = $3, target_id = $4, target_created = $5 WHERE job_id = $1 AND row_no = $2",
      [jobId, r.row_no, target.type, target.id, target.created]);
  }
  await tx.client.query("UPDATE abcrm.import_jobs SET status = 'committed', committed_at = now(), stats = stats || $2 WHERE id = $1", [jobId, { commit: counts }]);
  await appendAudit(tx, { actor, action: "import.committed", subject: { type: "import_job", id: jobId } });
  await emit(tx, "import.job.committed", { job_id: jobId, stats: counts });
  return counts;
}

/**
 * Removes what the job created, unless someone changed it after the commit (those are kept and reported).
 * Matched pre-existing records are never touched.
 */
export async function rollbackImport(tx: TenantTx, actor: Actor, jobId: string) {
  const job = await getJob(tx, jobId);
  if (job.status !== "committed" || !job.committed_at) throw new Problem("conflict", "Only committed imports can be rolled back");
  const result = { deleted: 0, kept_modified: 0 };
  const created = await tx.client.query<{ target_type: string; target_id: string }>(
    "SELECT target_type, target_id FROM abcrm.import_staging_rows WHERE job_id = $1 AND target_created ORDER BY row_no DESC", [jobId]);
  // Compare against the stored committed_at in SQL: JS Dates drop the microseconds Postgres keeps.
  const at = (param: string) => `(SELECT committed_at FROM abcrm.import_jobs WHERE id = ${param})`;
  const del = async (sql: string, id: string) => {
    const r = await tx.client.query(sql.replaceAll("$2", at("$2")), [id, job.id]);
    if (r.rowCount) result.deleted++; else result.kept_modified++;
  };
  // Contacts first, then accounts (an account is deleted only if nothing else references it).
  for (const r of created.rows.filter((x) => x.target_type === "contact")) {
    await del("DELETE FROM abcrm.contacts WHERE id = $1 AND updated_at <= $2", r.target_id);
  }
  for (const r of created.rows.filter((x) => x.target_type === "account")) {
    await del(`DELETE FROM abcrm.accounts a WHERE a.id = $1 AND a.updated_at <= $2
      AND NOT EXISTS (SELECT 1 FROM abcrm.contacts c WHERE c.account_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM abcrm.opportunities o WHERE o.account_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM abcrm.activities x WHERE x.account_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM abcrm.candidates d WHERE d.account_id = a.id)`, r.target_id);
  }
  for (const r of created.rows.filter((x) => x.target_type === "suppression")) {
    await del("DELETE FROM abcrm.suppression_entries WHERE id = $1 AND reason = 'import' AND created_at <= $2", r.target_id);
  }
  // Accounts auto-created for contact rows were recorded only via contacts; remove orphans from this job too.
  const orphans = await tx.client.query(
    `DELETE FROM abcrm.accounts a WHERE a.source->>'import_job_id' = $1::text AND a.updated_at <= $2
       AND NOT EXISTS (SELECT 1 FROM abcrm.contacts c WHERE c.account_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM abcrm.opportunities o WHERE o.account_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM abcrm.activities x WHERE x.account_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM abcrm.candidates d WHERE d.account_id = a.id)`.replaceAll("$2", at("$1::uuid")), [job.id]);
  result.deleted += orphans.rowCount ?? 0;
  await tx.client.query("UPDATE abcrm.import_jobs SET status = 'rolled_back', rolled_back_at = now(), stats = stats || $2 WHERE id = $1", [jobId, { rollback: result }]);
  await appendAudit(tx, { actor, action: "import.rolled_back", subject: { type: "import_job", id: jobId } });
  await emit(tx, "import.job.rolled_back", { job_id: jobId, stats: result });
  return result;
}

export async function getImportJob(tx: TenantTx, jobId: string) {
  const { rows: [j] } = await tx.client.query(
    `SELECT j.id, j.source, j.purpose, j.status, j.filename, j.stats, j.created_at, j.committed_at, j.rolled_back_at,
            m.field_map, m.object_map->'headers' AS headers, m.approved_at AS mapping_approved_at
     FROM abcrm.import_jobs j JOIN abcrm.import_mappings m ON m.id = j.mapping_id WHERE j.id = $1`, [jobId]);
  if (!j) throw notFound("Import job");
  return j;
}

export async function listImportRows(tx: TenantTx, jobId: string, opts: { status?: string; limit: number }) {
  await getImportJob(tx, jobId);
  const { rows } = await tx.client.query(
    `SELECT row_no, status, errors, raw FROM abcrm.import_staging_rows WHERE job_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY row_no LIMIT $3`,
    [jobId, opts.status ?? null, opts.limit]);
  return rows;
}


/** GET /imports: recent jobs, newest first (the import screen's history). */
export async function listImportJobs(tx: TenantTx, opts: { limit: number }) {
  const { rows } = await tx.client.query(
    `SELECT j.id, j.source, j.purpose, j.status, j.filename, j.stats, j.created_at, j.committed_at, j.rolled_back_at, u.email AS created_by_email
     FROM abcrm.import_jobs j LEFT JOIN abcrm.users u ON u.id = j.created_by ORDER BY j.created_at DESC LIMIT $1`, [opts.limit]);
  return rows;
}
