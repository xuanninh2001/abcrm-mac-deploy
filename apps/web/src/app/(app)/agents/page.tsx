import { PageHeading } from "@/components/PageHeading";
import { api, me } from "@/lib/api";
import { Action } from "@/components/Action";
import { AgentBudget } from "@/components/AgentBudget";

export const dynamic = "force-dynamic";

type Agent = { id: string; template_key: string; name: string; status: string; paused_reason: string | null; credit_budget_daily: number | null;
  credit_budget_monthly: number | null; credits_today: number; credits_month: number };

const REASONS: Record<string, string> = { manual: "paused by a person", budget: "budget reached", anomaly: "unusual spend", quality_breaker: "low approval rate",
  entitlement: "plan limit", kill_switch: "kill switch" };

export default async function Agents() {
  const [agents, user] = await Promise.all([api<{ data: Agent[] }>("/agents"), me()]);
  const canManage = ["owner", "admin", "head_of_bd"].includes(user.role);
  const isOwner = ["owner", "admin"].includes(user.role);
  return (
    <>
      <PageHeading title="Agents" eyebrow="AUTOMATION" description="Monitor your agents, manage budgets and control active runs." />
      <section className="card">
        {agents.data.length === 0 && <p className="muted">Agents appear here after their first run.</p>}
        <div className="table-scroll" role="region" aria-label="Agents" tabIndex={0}><table>
          <thead><tr><th>Agent</th><th>Status</th><th>Credits today / month</th><th>Budgets (daily / monthly)</th><th></th></tr></thead>
          <tbody>{agents.data.map((a) => (
            <tr key={a.id}>
              <td>{a.name} <span className="muted small">{a.template_key}</span></td>
              <td><span className={`badge ${a.status === "active" ? "" : "warn"}`}>{a.status}</span>{a.paused_reason && <div className="small muted">{REASONS[a.paused_reason] ?? a.paused_reason}</div>}</td>
              <td>{a.credits_today} / {a.credits_month}</td>
              <td>{canManage ? <AgentBudget agent={a} /> : `${a.credit_budget_daily ?? "—"} / ${a.credit_budget_monthly ?? "—"}`}</td>
              <td>{canManage && (a.status === "active"
                ? <Action path={`/agents/${a.id}/pause`}>Pause</Action>
                : <Action className="primary" path={`/agents/${a.id}/resume`}>Resume</Action>)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
      {isOwner && (
        <section className="card" aria-label="Kill switch">
          <h2 style={{ marginTop: 0 }}>Kill switch</h2>
          <p className="small muted">Stops every agent run in this workspace immediately. People can still work in the CRM and inbox.</p>
          <div className="row">
            <Action className="danger" path="/tenant/kill-switch" body={{ enabled: true }} confirm="Stop all agents now?">Stop all agents</Action>
            <Action path="/tenant/kill-switch" body={{ enabled: false }}>Allow agents again</Action>
          </div>
        </section>
      )}
    </>
  );
}
