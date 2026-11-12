"use client";

import { useState } from "react";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

export type Supply = {
  version: number; status: string; verticals: string[]; lead_types: { vertical: string; type: string; formats: string[]; delivery?: string[] }[];
  traffic_sources: string[]; states: string[]; compliance_assets: { trustedform?: boolean; jornaya?: boolean; dnc_scrub?: boolean; consent_language_url?: string };
  positioning: string | null;
};

const VERTICALS = ["insurance", "finance", "home_services", "education", "legal"];
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Supply Profile editor: the essentials as fields, lead types as "vertical:type" lines. Saving writes the draft; Submit opens a G-T1. */
export function SupplyForm({ initial, canEdit, locked }: { initial: Supply | null; canEdit: boolean; locked: boolean }) {
  const router = useRouter();
  const { busy, runTask } = useTask();
  const [verticals, setVerticals] = useState<string[]>(initial?.verticals ?? ["insurance"]);
  const [leadTypes, setLeadTypes] = useState((initial?.lead_types ?? []).map((l) => `${l.vertical}:${l.type}`).join("\n"));
  const [states, setStates] = useState((initial?.states ?? ["ALL"]).join(", "));
  const [traffic, setTraffic] = useState((initial?.traffic_sources ?? []).join(", "));
  const [assets, setAssets] = useState({ trustedform: !!initial?.compliance_assets.trustedform, jornaya: !!initial?.compliance_assets.jornaya, dnc_scrub: !!initial?.compliance_assets.dnc_scrub });
  const [positioning, setPositioning] = useState(initial?.positioning ?? "");
  const [failed, setFailed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const disabled = busy || !canEdit || locked;

  const payload = () => ({
    verticals,
    lead_types: leadTypes.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [vertical, type] = l.split(":").map((x) => x.trim());
      return { vertical, type, formats: ["data_lead"], delivery: ["ping_post", "direct_post"] };
    }),
    states: list(states).map((s) => s.toUpperCase()), traffic_sources: list(traffic), compliance_assets: assets,
    ...(positioning.trim() ? { positioning } : {}),
  });

  return (
    <div>
      <fieldset disabled={disabled} style={{ border: 0, padding: 0 }}>
        <p className="row">Verticals:
          {VERTICALS.map((v) => (
            <label key={v} className="small"><input type="checkbox" checked={verticals.includes(v)}
              onChange={(e) => setVerticals((s) => (e.target.checked ? [...s, v] : s.filter((x) => x !== v)))} /> {v.replace("_", " ")}</label>
          ))}
        </p>
        <div className="grid2">
          <label>Lead types (one per line, vertical:type)<textarea aria-label="Lead types" style={{ minHeight: 80 }} value={leadTypes} onChange={(e) => setLeadTypes(e.target.value)} placeholder="insurance:aca_health" /></label>
          <label>Positioning<textarea aria-label="Positioning" style={{ minHeight: 80 }} value={positioning} onChange={(e) => setPositioning(e.target.value)} /></label>
        </div>
        <p className="row">
          <label>States <input aria-label="States" value={states} onChange={(e) => setStates(e.target.value)} /></label>
          <label>Traffic sources <input aria-label="Traffic sources" value={traffic} onChange={(e) => setTraffic(e.target.value)} placeholder="search, social" /></label>
        </p>
        <p className="row">Compliance:
          {(["trustedform", "jornaya", "dnc_scrub"] as const).map((k) => (
            <label key={k} className="small"><input type="checkbox" checked={assets[k]} onChange={(e) => setAssets((a) => ({ ...a, [k]: e.target.checked }))} /> {k.replace("_", " ")}</label>
          ))}
        </p>
      </fieldset>
      {canEdit && (
        <div className="row">
          <Button busy={busy} disabled={locked} onClick={() => runTask(async () => {
            try { await call("/supply-profile/draft", { method: "PUT", body: payload() }); setFailed(false); setMsg("Draft saved."); router.refresh(); toast.success("Changes saved."); } catch (e) { setFailed(true); setMsg(errorText(e)); toast.error(errorText(e)); }
          })}>Save draft</Button>
          <Button busy={busy} className="primary" disabled={locked} onClick={() => runTask(async () => {
            try { await call("/supply-profile/draft", { method: "PUT", body: payload() }); await call("/supply-profile/draft/submit", { body: {} }); setFailed(false); setMsg("Submitted for approval."); router.refresh(); toast.success("Changes saved."); }
            catch (e) { setFailed(true); setMsg(errorText(e)); toast.error(errorText(e)); }
          })}>Save &amp; submit for approval</Button>
          {locked && <span className="muted small">Waiting for approval.</span>}
          {msg && <span className={failed ? "error small" : "small"} role={failed ? "alert" : "status"}>{msg}</span>}
        </div>
      )}
    </div>
  );
}
