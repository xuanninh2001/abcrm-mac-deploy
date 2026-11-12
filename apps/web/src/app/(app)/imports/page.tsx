import { PageHeading } from "@/components/PageHeading";
import Link from "next/link";
import { api, me } from "@/lib/api";
import { ImportUpload } from "@/components/ImportUpload";
import { fieldLabel } from "@/lib/text";

export const dynamic = "force-dynamic";

type Job = { id: string; purpose: string; status: string; filename: string | null; stats: { rows?: number; commit?: { created: number; matched: number } };
  created_at: string; created_by_email: string | null };

export default async function Imports() {
  const user = await me();
  if (!["owner", "admin"].includes(user.role)) return <><h1>Import</h1><p className="muted">Only owners and admins can import data.</p></>;
  const jobs = await api<{ data: Job[] }>("/imports?limit=50");
  return (
    <>
      <PageHeading title="Import" eyebrow="DATA OPERATIONS" description="Upload, map and validate your data before committing changes." />
      <section className="card" aria-label="New import">
        <h2 style={{ marginTop: 0 }}>New import</h2>
        <p className="small muted">Nothing is written until you run a dry-run and commit. A committed import can be rolled back.</p>
        <ImportUpload />
      </section>
      <section className="card" aria-label="Import history">
        <h2 style={{ marginTop: 0 }}>History</h2>
        {jobs.data.length === 0 ? <p className="muted">No imports yet.</p> : (
          <div className="table-scroll" role="region" aria-label="Import history" tabIndex={0}><table>
            <thead><tr><th>File</th><th>Type</th><th>Rows</th><th>Status</th><th>Result</th><th>By</th><th>When</th></tr></thead>
            <tbody>{jobs.data.map((j) => (
              <tr key={j.id}>
                <td><Link href={`/imports/${j.id}`}>{j.filename ?? j.id.slice(0, 8)}</Link></td>
                <td>{fieldLabel(j.purpose)}</td>
                <td>{j.stats.rows ?? "—"}</td>
                <td><span className={`badge ${j.status === "committed" ? "" : j.status === "failed" ? "bad" : "warn"}`}>{j.status.replace(/_/g, " ")}</span></td>
                <td className="small">{j.stats.commit ? `${j.stats.commit.created} created, ${j.stats.commit.matched} matched` : "—"}</td>
                <td className="small">{j.created_by_email ?? "—"}</td>
                <td className="small">{new Date(j.created_at).toLocaleString()}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
