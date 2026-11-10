import { api, me } from "@/lib/api";
import { Action } from "@/components/Action";
import { SupplyForm, type Supply } from "@/components/SupplyForm";
import { ClonePack } from "@/components/ClonePack";

export const dynamic = "force-dynamic";

type Decision = { id: string; gate_id: string; subject_type: string; explanation: string | null; content_hash: string; created_at: string; evidence: Record<string, unknown> };
type Ipp = { id: string; name: string; version: number; status: string };
type Lineage = { lineage_id: string; name: string; active_id: string | null; active_version: number | null; draft_id: string | null; draft_status: string | null };

/** Setup: approvals waiting (G-T1), what the agency sells, and who to look for (packs, playbooks, IPPs). */
export default async function Setup() {
  const [user, decisions, supply, packs, playbooks, ipps] = await Promise.all([
    me(), api<{ data: Decision[] }>("/decisions?lane=setup"), api<{ active: Supply | null; draft: Supply | null }>("/supply-profile"),
    api<{ data: string[] }>("/vertical-packs"), api<{ data: Lineage[] }>("/playbooks"), api<{ data: Ipp[] }>("/ipps"),
  ]);
  const canApprove = ["owner", "admin", "head_of_bd"].includes(user.role);
  const packDetails = await Promise.all(packs.data.map((k) => api<{ key: string; ipp_templates: string[] }>(`/vertical-packs/${k}`)));
  return (
    <>
      <h1>Setup</h1>
      <section className="card" aria-label="Approvals">
        <h2 style={{ marginTop: 0 }}>Waiting for approval</h2>
        {decisions.data.length === 0 && <p className="muted">Nothing to approve.</p>}
        {decisions.data.map((d) => (
          <div key={d.id} className="spread" style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
            <div>
              <strong>{d.explanation ?? d.subject_type}</strong> <span className="badge">{d.gate_id}</span>
              {"preview" in d.evidence && <PreviewNote preview={d.evidence.preview as Preview | null} />}
            </div>
            {canApprove && (
              <div className="row">
                <Action className="primary" path={`/decisions/${d.id}/approve`} body={{ content_hash: d.content_hash }}>Approve</Action>
                <Action className="danger" path={`/decisions/${d.id}/reject`} body={{ reason_code: "needs_changes" }}>Return to draft</Action>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="card" aria-label="Supply profile">
        <h2 style={{ marginTop: 0 }}>Supply profile</h2>
        <p className="muted small">
          {supply.active ? `Active: version ${supply.active.version}.` : "No active profile yet."}
          {supply.draft ? ` Draft v${supply.draft.version} (${supply.draft.status.replace("_", " ")}).` : ""}
        </p>
        <SupplyForm initial={supply.draft ?? supply.active} canEdit={canApprove} locked={supply.draft?.status === "pending_approval"} />
      </section>

      <section className="card" aria-label="Vertical packs">
        <h2 style={{ marginTop: 0 }}>Start from a vertical pack</h2>
        {packDetails.map((p) => <ClonePack key={p.key} pack={p.key} templates={p.ipp_templates} disabled={!canApprove} />)}
      </section>

      <div className="grid2">
        <section className="card" aria-label="Playbooks">
          <h2 style={{ marginTop: 0 }}>Playbooks</h2>
          <Lineages rows={playbooks.data} base="/setup/playbooks" />
        </section>
        <section className="card" aria-label="IPPs">
          <h2 style={{ marginTop: 0 }}>Ideal partner profiles</h2>
          {ipps.data.length === 0 && <p className="muted">None yet. Clone a vertical pack to start.</p>}
          {ipps.data.length > 0 && (
            <table>
              <thead><tr><th>Name</th><th>Version</th><th>Status</th></tr></thead>
              <tbody>{ipps.data.map((i) => (
                <tr key={i.id}><td><a href={`/setup/ipps/${i.id}`}>{i.name}</a></td><td>v{i.version}</td><td>{i.status.replace("_", " ")}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

type Preview = { sample_size: number; tier_distribution: Record<string, number> } | null;
function PreviewNote({ preview }: { preview: Preview }) {
  if (!preview) return <div className="small muted">No preview attached.</div>;
  const d = preview.tier_distribution;
  return <div className="small muted">Preview on {preview.sample_size} accounts: A {d.A ?? 0} · B {d.B ?? 0} · C {d.C ?? 0} · D {d.D ?? 0}</div>;
}

function Lineages({ rows, base }: { rows: Lineage[]; base: string }) {
  if (!rows.length) return <p className="muted">None yet. Clone a vertical pack to start.</p>;
  return (
    <table>
      <thead><tr><th>Name</th><th>Active</th><th>Draft</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.lineage_id}>
            <td>{r.name}</td>
            <td>{r.active_id ? <a href={`${base}/${r.active_id}`}>v{r.active_version}</a> : <span className="muted">—</span>}</td>
            <td>{r.draft_id ? <a href={`${base}/${r.draft_id}`}>{r.draft_status?.replace("_", " ")}</a> : <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
