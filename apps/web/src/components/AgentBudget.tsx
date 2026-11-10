"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

const num = (s: string) => (s.trim() ? Number(s) : null);

export function AgentBudget({ agent }: { agent: { id: string; credit_budget_daily: number | null; credit_budget_monthly: number | null } }) {
  const router = useRouter();
  const [daily, setDaily] = useState(agent.credit_budget_daily?.toString() ?? "");
  const [monthly, setMonthly] = useState(agent.credit_budget_monthly?.toString() ?? "");
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="row small">
      <input aria-label="Daily budget" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="none" style={{ width: 70 }} />
      <input aria-label="Monthly budget" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="none" style={{ width: 80 }} />
      <button onClick={async () => {
        try { await call(`/agents/${agent.id}`, { method: "PATCH", body: { credit_budget_daily: num(daily), credit_budget_monthly: num(monthly) } }); setErr(null); router.refresh(); }
        catch (e) { setErr(errorText(e)); }
      }}>Save</button>
      {err && <span className="error">{err}</span>}
    </span>
  );
}
