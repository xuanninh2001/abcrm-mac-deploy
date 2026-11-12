"use client";

import { useEffect, useState } from "react";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

type Estimate = { agent_credits: number; contact_credits: number; requires_approval: boolean };

/** New sourcing run with its estimate shown before starting (pricing doc §5). Large runs go to G-T1. */
export function NewRun({ ipps, preselect }: { ipps: { id: string; name: string }[]; preselect?: string }) {
  const router = useRouter();
  const { busy, runTask } = useTask();
  const [ipp, setIpp] = useState(preselect && ipps.some((i) => i.id === preselect) ? preselect : ipps[0]?.id ?? "");
  const [target, setTarget] = useState(100);
  const [est, setEst] = useState<Estimate | null>(null);
  const [failed, setFailed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const validTarget = Number.isInteger(target) && target >= 1 && target <= 5000;
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState(false);
  useEffect(() => {
    let active = true;
    setEst(null); setEstimateError(false); setEstimating(validTarget);
    if (!validTarget) return;
    const t = setTimeout(() => {
      call<Estimate>("/sourcing-runs/estimate", { body: { target_count: target } })
        .then(value => { if (active) setEst(value); })
        .catch(() => { if (active) setEstimateError(true); })
        .finally(() => { if (active) setEstimating(false); });
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [target, validTarget]);
  if (!ipps.length) return <div className="card muted">Activate an IPP in Setup to start sourcing.</div>;
  return (
    <section className="card" aria-label="New run">
      <div className="row">
        <label>IPP <select disabled={busy} aria-label="IPP" value={ipp} onChange={(e) => setIpp(e.target.value)}>{ipps.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <label>Target buyers <input disabled={busy} type="number" aria-label="Target count" min={1} max={5000} value={target} onChange={(e) => setTarget(Number(e.target.value))} style={{ width: 90 }} /></label>
        {est && <span className="muted small">≈ {est.agent_credits} agent credits and {est.contact_credits} contact credits{est.requires_approval ? " · needs approval" : ""}</span>}
        {estimating && <span role="status" className="small muted">Estimating credits...</span>}
        {estimateError && <span role="alert" className="error small">Estimate unavailable. Change the target to try again.</span>}
        {!validTarget && <span role="alert" className="error small">Enter a whole number from 1 to 5,000.</span>}
        <Button busy={busy} disabled={!validTarget || estimating || !est} className="primary" onClick={() => runTask(async () => {
          try { const r = await call<{ status: string }>("/sourcing-runs", { body: { ipp_id: ipp, target_count: target } }); setFailed(false); setMsg(r.status === "pending_approval" ? "Waiting for approval in Setup." : "Run queued."); router.refresh(); toast.success("Sourcing request received."); }
          catch (e) { setFailed(true); setMsg(errorText(e)); toast.error(errorText(e)); }
        })}>Start run</Button>
        {msg && <span className={failed ? "error small" : "small"} role={failed ? "alert" : "status"}>{msg}</span>}
      </div>
    </section>
  );
}
