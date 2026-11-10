"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

export function UsageSettings({ balance }: { balance: { meter: string; overage_enabled: boolean; spend_cap_usd: number | null } }) {
  const router = useRouter();
  const [overage, setOverage] = useState(balance.overage_enabled);
  const [cap, setCap] = useState(balance.spend_cap_usd?.toString() ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="row small">
      <label><input type="checkbox" checked={overage} onChange={(e) => setOverage(e.target.checked)} /> Allow overage</label>
      <label>Spend cap $ <input aria-label={`${balance.meter} spend cap`} value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 80 }} placeholder="none" /></label>
      <button onClick={async () => {
        try {
          await call("/usage/settings", { method: "PATCH", body: { meter: balance.meter, overage_enabled: overage, spend_cap_usd: cap.trim() ? Number(cap) : null } });
          setMsg("Saved."); router.refresh();
        } catch (e) { setMsg(errorText(e)); }
      }}>Save</button>
      {msg && <span role="status">{msg}</span>}
    </div>
  );
}
