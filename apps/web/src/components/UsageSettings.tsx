"use client";

import { useState } from "react";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

export function UsageSettings({ balance }: { balance: { meter: string; overage_enabled: boolean; spend_cap_usd: number | null } }) {
  const router = useRouter();
  const { busy, runTask } = useTask();
  const [overage, setOverage] = useState(balance.overage_enabled);
  const [cap, setCap] = useState(balance.spend_cap_usd?.toString() ?? "");
  const [failed, setFailed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="row small">
      <label><input disabled={busy} type="checkbox" checked={overage} onChange={(e) => setOverage(e.target.checked)} /> Allow overage</label>
      <label>Spend cap $ <input disabled={busy} aria-label={`${balance.meter} spend cap`} value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 80 }} placeholder="none" /></label>
      <Button busy={busy} onClick={() => runTask(async () => {
        try {
          await call("/usage/settings", { method: "PATCH", body: { meter: balance.meter, overage_enabled: overage, spend_cap_usd: cap.trim() ? Number(cap) : null } });
          setFailed(false); setMsg("Saved."); router.refresh(); toast.success("Changes saved.");
        } catch (e) { setFailed(true); setMsg(errorText(e)); toast.error(errorText(e)); }
      })}>Save</Button>
      {msg && <span className={failed ? "error" : undefined} role={failed ? "alert" : "status"}>{msg}</span>}
    </div>
  );
}
