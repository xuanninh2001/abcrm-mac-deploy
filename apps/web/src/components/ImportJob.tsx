"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";
import { fieldLabel, mappingComplete } from "@/lib/text";

type DryRun = { rows: number; valid: number; warning: number; error: number; duplicate_in_file: number };
export type Job = {
  id: string; purpose: string; status: string; filename: string | null; headers: string[];
  field_map: { source: string; target: string; confidence: number }[]; targets: { fields: string[]; required: string[][] };
  stats: { rows?: number; sheets?: string[]; dry_run?: DryRun; commit?: { created: number; matched: number; suppressed: number };
    rollback?: Record<string, number> };
};
export type Row = { row_no: number; status: string; errors: string[]; raw: Record<string, unknown> };

const EDITABLE = ["mapping", "dry_run", "ready"];

/** Steps 2–4 of an import: confirm the column mapping, dry-run, commit (and roll back if needed). */
export function ImportJob({ job, errors, warnings }: { job: Job; errors: Row[]; warnings: Row[] }) {
  const router = useRouter();
  const initial = useMemo(() => Object.fromEntries(job.headers.map((h) => [h, job.field_map.find((m) => m.source === h)?.target ?? ""])), [job]);
  const [map, setMap] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const editable = EDITABLE.includes(job.status);
  const mapped = Object.values(map).filter(Boolean);
  const duplicateTarget = mapped.find((t, i) => mapped.indexOf(t) !== i);
  const complete = mappingComplete(job.targets.required, mapped);
  const changed = JSON.stringify(map) !== JSON.stringify(initial);
  const dry = job.stats.dry_run;

  const run = async (label: string, fn: () => Promise<unknown>, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(label); setErr(null);
    try { await fn(); router.refresh(); } catch (e) { setErr(errorText(e)); } finally { setBusy(null); }
  };
  const save = () => call(`/imports/${job.id}/mapping`, { method: "PUT", body: { field_map: Object.entries(map).filter(([, t]) => t).map(([source, target]) => ({ source, target })) } });

  return (
    <article aria-label="Import job">
      <header className="spread">
        <h1 style={{ marginBottom: 4 }}>{job.filename ?? "Import"} <span className="muted small">· {fieldLabel(job.purpose)} · {job.stats.rows ?? 0} rows</span></h1>
        <span className={`badge ${job.status === "committed" ? "" : "warn"}`}>{job.status.replace(/_/g, " ")}</span>
      </header>
      {(job.stats.sheets?.length ?? 0) > 1 && <p className="small muted">This workbook has sheets {job.stats.sheets!.join(", ")}. To import another sheet, upload again and name it.</p>}

      <section className="card" aria-label="Column mapping">
        <h2 style={{ marginTop: 0 }}>1. Columns</h2>
        <p className="small muted">Required: {job.targets.required.map((g) => g.map(fieldLabel).join(" + ")).join(", or ")}.</p>
        <table>
          <thead><tr><th>Column in your file</th><th>Imports as</th></tr></thead>
          <tbody>{job.headers.map((h) => (
            <tr key={h}>
              <td>{h}</td>
              <td><select aria-label={`Field for ${h}`} value={map[h] ?? ""} disabled={!editable} onChange={(e) => setMap({ ...map, [h]: e.target.value })}>
                <option value="">— ignore —</option>
                {job.targets.fields.map((f) => <option key={f} value={f}>{fieldLabel(f)}</option>)}
              </select></td>
            </tr>
          ))}</tbody>
        </table>
        {!complete && <p className="error small">Map the required fields before the dry-run.</p>}
        {duplicateTarget && <p className="error small">{fieldLabel(duplicateTarget)} is mapped twice.</p>}
      </section>

      <section className="card" aria-label="Dry-run">
        <h2 style={{ marginTop: 0 }}>2. Dry-run</h2>
        <p className="small muted">Checks every row with this mapping. Nothing is written to the CRM.</p>
        {editable && (
          <button className="primary" disabled={!complete || !!duplicateTarget || !!busy}
            onClick={() => run("dry", async () => { if (changed || !dry) await save(); await call(`/imports/${job.id}/dry-run`, { body: {} }); })}>
            {busy === "dry" ? "Checking…" : dry && !changed ? "Run the dry-run again" : "Save mapping and run the dry-run"}
          </button>
        )}
        {dry && (
          <>
            <p role="status">{dry.valid} ready · {dry.warning} with warnings · {dry.error} with errors (skipped) · {dry.duplicate_in_file} duplicates in the file (skipped)</p>
            {changed && <p className="error small">The mapping changed since this dry-run. Run it again before committing.</p>}
            <RowList title="Errors (these rows will be skipped)" rows={errors} />
            <RowList title="Warnings (these rows will be imported)" rows={warnings} />
          </>
        )}
      </section>

      <section className="card" aria-label="Commit">
        <h2 style={{ marginTop: 0 }}>3. Commit</h2>
        {job.status === "ready" && !changed && (
          <button className="primary" disabled={!!busy || !dry || dry.valid + dry.warning === 0}
            onClick={() => run("commit", () => call(`/imports/${job.id}/commit`, { body: {} }), `Import ${(dry?.valid ?? 0) + (dry?.warning ?? 0)} rows into the CRM?`)}>
            {busy === "commit" ? "Importing…" : `Import ${(dry?.valid ?? 0) + (dry?.warning ?? 0)} rows`}
          </button>
        )}
        {job.status !== "ready" && job.status !== "committed" && job.status !== "rolled_back" && <p className="muted small">Run a dry-run first.</p>}
        {job.stats.commit && (
          <p role="status">{job.stats.commit.created} created, {job.stats.commit.matched} matched existing records{job.stats.commit.suppressed ? `, ${job.stats.commit.suppressed} contacts suppressed` : ""}.</p>
        )}
        {job.status === "committed" && (
          <button className="danger" disabled={!!busy}
            onClick={() => run("rollback", () => call(`/imports/${job.id}/rollback`, { body: {} }), "Roll back this import? Records it created are removed unless someone changed them since; records it matched are left as they were.")}>
            {busy === "rollback" ? "Rolling back…" : "Roll back"}
          </button>
        )}
        {job.status === "rolled_back" && (
          <p role="status">Rolled back: {job.stats.rollback?.deleted ?? 0} records removed{job.stats.rollback?.kept_modified ? `, ${job.stats.rollback.kept_modified} kept because they changed after the import` : ""}.</p>
        )}
      </section>
      {err && <p className="error" role="alert">{err}</p>}
    </article>
  );
}

function RowList({ title, rows }: { title: string; rows: Row[] }) {
  if (!rows.length) return null;
  return (
    <details>
      <summary>{title}: first {rows.length}</summary>
      <table>
        <thead><tr><th>Row</th><th>Problem</th><th>Data</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.row_no}><td>{r.row_no}</td><td className="small">{r.errors.join("; ")}</td>
            <td className="small muted">{Object.entries(r.raw).slice(0, 4).map(([k, v]) => `${k}: ${String(v ?? "")}`).join(" · ")}</td></tr>
        ))}</tbody>
      </table>
    </details>
  );
}
