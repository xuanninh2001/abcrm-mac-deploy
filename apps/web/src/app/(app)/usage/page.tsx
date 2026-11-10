import { api, me } from "@/lib/api";
import { UsageSettings } from "@/components/UsageSettings";

export const dynamic = "force-dynamic";

type Balance = { meter: string; period: string; included: number; used: number; reserved: number; overage_enabled: boolean; spend_cap_usd: number | null; overage_unit_price_usd: number; hard_stop: boolean };
type Usage = { period: string; balances: Balance[]; by_action: { meter: string; action_type: string; events: number; credits: number }[];
  by_agent: { agent_definition_id: string; template_key: string; name: string; credits: number }[] };

export default async function UsagePage() {
  const [u, user] = await Promise.all([api<Usage>("/usage"), me()]);
  const canManage = ["owner", "admin"].includes(user.role);
  return (
    <>
      <h1>Usage <span className="muted small">since {u.period}</span></h1>
      <div className="grid2">
        {u.balances.map((b) => {
          const pct = b.included ? Math.round((100 * (b.used + b.reserved)) / b.included) : 0;
          return (
            <section key={b.meter} className="card" aria-label={`${b.meter} credits`}>
              <h2 style={{ marginTop: 0, textTransform: "capitalize" }}>{b.meter} credits</h2>
              <div className={`bar ${pct > 100 ? "over" : ""}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <p>{b.used} used{b.reserved ? ` + ${b.reserved} reserved` : ""} of {b.included} included ({pct}%)</p>
              <p className="small muted">
                {b.hard_stop ? "Hard stop at the included amount." : `Overage on at $${b.overage_unit_price_usd}/credit${b.spend_cap_usd !== null ? `, capped at $${b.spend_cap_usd}` : ", no cap"}.`}
              </p>
              {canManage && <UsageSettings balance={b} />}
            </section>
          );
        })}
      </div>
      <div className="grid2">
        <section className="card" aria-label="By action">
          <h2 style={{ marginTop: 0 }}>By action</h2>
          <table><thead><tr><th>Meter</th><th>Action</th><th>Events</th><th>Credits</th></tr></thead>
            <tbody>{u.by_action.map((r) => <tr key={r.meter + r.action_type}><td>{r.meter}</td><td>{r.action_type.replace(/_/g, " ")}</td><td>{r.events}</td><td>{r.credits}</td></tr>)}</tbody></table>
        </section>
        <section className="card" aria-label="By agent">
          <h2 style={{ marginTop: 0 }}>By agent</h2>
          <table><thead><tr><th>Agent</th><th>Credits</th></tr></thead>
            <tbody>{u.by_agent.map((r) => <tr key={r.agent_definition_id}><td>{r.name} <span className="muted small">{r.template_key}</span></td><td>{r.credits}</td></tr>)}</tbody></table>
        </section>
      </div>
    </>
  );
}
