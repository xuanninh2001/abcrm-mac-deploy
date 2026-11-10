"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

type Estimate = { agent_credits: number; contact_credits: number; requires_approval: boolean };

/** New sourcing run with its estimate shown before starting (pricing doc §5). Large runs go to G-T1. */
export function NewRun({ ipps, preselect }: { ipps: { id: string; name: string }[]; preselect?: string }) {
  const router = useRouter();
  const [ipp, setIpp] = useState(preselect && ipps.some((i) => i.id === preselect) ? preselect : ipps[0]?.id ?? "");
  const [target, setTarget] = useState(100);
  const [est, setEst] = useState<Estimate | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { call<Estimate>("/sourcing-runs/estimate", { body: { target_count: target } }).then(setEst).catch(() => setEst(null)); }, 250);
    return () => clearTimeout(t);
  }, [target]);
  if (!ipps.length) return <div className="card muted">Activate an IPP in Setup to start sourcing.</div>;
  return (
    <section className="card" aria-label="New run">
      <div className="row">
        <label>IPP <select aria-label="IPP" value={ipp} onChange={(e) => setIpp(e.target.value)}>{ipps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <label>Target buyers <input type="number" aria-label="Target count" min={1} max={5000} value={target} onChange={(e) => setTarget(Number(e.target.value))} style={{ width: 90 }} /></label>
        {est && <span className="muted small">≈ {est.agent_credits} agent credits and {est.contact_credits} contact credits{est.requires_approval ? " · needs approval" : ""}</span>}
        <button className="primary" onClick={async () => {
          try { const r = await call<{ status: string }>("/sourcing-runs", { body: { ipp_id: ipp, target_count: target } }); setMsg(r.status === "pending_approval" ? "Waiting for approval in Setup." : "Run queued."); router.refresh(); }
          catch (e) { setMsg(errorText(e)); }
        }}>Start run</button>
        {msg && <span className="small" role="status">{msg}</span>}
      </div>
    </section>
  );
}
