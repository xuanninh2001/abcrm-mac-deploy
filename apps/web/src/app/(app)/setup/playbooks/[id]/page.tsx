import { api, me } from "@/lib/api";
import { PlaybookEditor, type Playbook } from "@/components/PlaybookEditor";
import { Action } from "@/components/Action";

export const dynamic = "force-dynamic";

type PreviewRow = { id: string; status: string; sample_size: number; tier_distribution: Record<string, number>; agent_credits: string; created_at: string };
type PreviewDetail = PreviewRow & { results: { account_id: string; name: string; domain: string; tier: string; pct: number; stopped_at: string | null }[]; error: string | null };

export default async function PlaybookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [pb, previews, user] = await Promise.all([api<Playbook>(`/playbooks/${id}`), api<{ data: PreviewRow[] }>(`/playbooks/${id}/previews`), me()]);
  const latest = previews.data[0] ? await api<PreviewDetail>(`/playbook-previews/${previews.data[0].id}`) : null;
  const canEdit = ["owner", "admin", "head_of_bd"].includes(user.role);
  return (
    <>
      <div className="small"><a href="/setup">← Setup</a></div>
      <h1>{pb.name} <span className="badge">v{pb.version} · {pb.status.replace("_", " ")}</span></h1>
      <PlaybookEditor playbook={pb} canEdit={canEdit} />
      <section className="card" aria-label="Preview">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Preview</h2>
          {canEdit && <Action path={`/playbooks/${id}/preview`} body={{ sample: "recent", size: 20 }}>Run preview on 20 recent accounts</Action>}
        </div>
        <p className="muted small">Scores this playbook against recent accounts with evidence without creating scorecards. Charged like scorecards.</p>
        {!latest && <p className="muted">No preview yet.</p>}
        {latest && (
          <>
            <p>
              <span className="badge">{latest.status}</span>{" "}
              {latest.status === "completed" && <>A {latest.tier_distribution.A ?? 0} · B {latest.tier_distribution.B ?? 0} · C {latest.tier_distribution.C ?? 0} · D {latest.tier_distribution.D ?? 0} on {latest.results.length} accounts · {latest.agent_credits} credits</>}
              {latest.error && <span className="error"> {latest.error}</span>}
            </p>
            {latest.results.length > 0 && (
              <div className="table-scroll" role="region" aria-label="Qualification preview" tabIndex={0}><table>
                <thead><tr><th>Company</th><th>Tier</th><th>Score</th><th>Stopped at</th></tr></thead>
                <tbody>{latest.results.map((r) => (
                  <tr key={r.account_id}><td>{r.name}<div className="muted small">{r.domain}</div></td><td><span className={`badge tier-${r.tier}`}>{r.tier}</span></td><td>{r.pct}%</td><td>{r.stopped_at ?? "—"}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </>
        )}
      </section>
    </>
  );
}
