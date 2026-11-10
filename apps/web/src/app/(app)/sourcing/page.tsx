import { api } from "@/lib/api";
import { Action } from "@/components/Action";
import { NewRun } from "@/components/NewRun";

export const dynamic = "force-dynamic";

type Run = { id: string; ipp_id: string; status: string; target_count: number; agent_credit_budget: number; contact_credit_budget: number;
  stats: { found?: number; deduped?: number; qualified?: number; carded?: number; agent_credits_used?: number; contact_credits_used?: number; error?: string };
  created_at: string };

export default async function Sourcing({ searchParams }: { searchParams: Promise<{ ipp?: string }> }) {
  const { ipp } = await searchParams;
  const [runs, ipps] = await Promise.all([api<{ data: Run[] }>("/sourcing-runs"), api<{ data: { id: string; name: string; status: string }[] }>("/ipps")]);
  const names = new Map(ipps.data.map((i) => [i.id, i.name]));
  return (
    <>
      <h1>Sourcing</h1>
      <NewRun ipps={ipps.data.filter((i) => i.status === "active")} preselect={ipp} />
      <section className="card" aria-label="Runs">
        <h2 style={{ marginTop: 0 }}>Runs</h2>
        {runs.data.length === 0 && <p className="muted">No runs yet.</p>}
        {runs.data.length > 0 && (
          <table>
            <thead><tr><th>IPP</th><th>Status</th><th>Found / target</th><th>Qualified</th><th>Cards</th><th>Credits (agent / contact)</th><th></th></tr></thead>
            <tbody>{runs.data.map((r) => (
              <tr key={r.id}>
                <td>{names.get(r.ipp_id) ?? r.ipp_id.slice(0, 8)}<div className="muted small">{new Date(r.created_at).toLocaleString()}</div></td>
                <td><span className="badge">{r.status.replace("_", " ")}</span>{r.stats.error && <div className="error small">{r.stats.error}</div>}</td>
                <td>{r.stats.found ?? 0} / {r.target_count}</td>
                <td>{r.stats.qualified ?? 0}</td>
                <td>{r.stats.carded ?? 0}</td>
                <td>{r.stats.agent_credits_used ?? 0} / {r.agent_credit_budget} · {r.stats.contact_credits_used ?? 0} / {r.contact_credit_budget}</td>
                <td className="row">
                  {r.status === "running" && <Action path={`/sourcing-runs/${r.id}/pause`}>Pause</Action>}
                  {r.status === "paused" && <Action path={`/sourcing-runs/${r.id}/resume`}>Resume</Action>}
                  {["queued", "running", "paused", "pending_approval"].includes(r.status) && <Action className="danger" path={`/sourcing-runs/${r.id}/cancel`} confirm="Cancel this run?">Cancel</Action>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
