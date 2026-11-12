"use client";

import { useState } from "react";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

const num = (s: string) => (s.trim() ? Number(s) : null);

export function AgentBudget({ agent }: { agent: { id: string; credit_budget_daily: number | null; credit_budget_monthly: number | null } }) {
  const router = useRouter();
  const { busy, runTask } = useTask();
  const [daily, setDaily] = useState(agent.credit_budget_daily?.toString() ?? "");
  const [monthly, setMonthly] = useState(agent.credit_budget_monthly?.toString() ?? "");
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="row small">
      <input disabled={busy} aria-label="Daily budget" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="none" style={{ width: 70 }} />
      <input disabled={busy} aria-label="Monthly budget" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="none" style={{ width: 80 }} />
      <Button busy={busy} onClick={() => runTask(async () => {
        try { await call(`/agents/${agent.id}`, { method: "PATCH", body: { credit_budget_daily: num(daily), credit_budget_monthly: num(monthly) } }); setErr(null); router.refresh(); toast.success("Changes saved."); }
        catch (e) { setErr(errorText(e)); toast.error(errorText(e)); }
      })}>Save</Button>
      {err && <span className="error" role="alert">{err}</span>}
    </span>
  );
}
