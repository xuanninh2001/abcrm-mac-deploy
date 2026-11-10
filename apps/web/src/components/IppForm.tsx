"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

export type Ipp = { id: string; lineage_id: string; name: string; version: number; status: string; vertical: string; lead_types: string[];
  buyer_types: string[]; purchase_formats: string[]; payout_models: string[]; size: Record<string, number>;
  signals: { web_paths: string[]; tech: string[]; text: string[] }; exclusions: { domains: string[]; keywords: string[]; buyer_types: string[] };
  contact_titles: string[]; contacts_per_account: number; playbook_id: string };

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/** IPP editor: who to look for and whom to contact. Submitting needs an active playbook (G-T1). */
export function IppForm({ ipp, canEdit }: { ipp: Ipp; canEdit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(ipp.name);
  const [titles, setTitles] = useState(ipp.contact_titles.join("\n"));
  const [perAccount, setPerAccount] = useState(ipp.contacts_per_account);
  const [excluded, setExcluded] = useState(ipp.exclusions.domains.join("\n"));
  const [msg, setMsg] = useState<string | null>(null);
  const draft = ipp.status === "draft";
  const body = () => ({
    name, vertical: ipp.vertical, lead_types: ipp.lead_types, buyer_types: ipp.buyer_types, purchase_formats: ipp.purchase_formats,
    payout_models: ipp.payout_models, size: ipp.size, signals: ipp.signals,
    exclusions: { ...ipp.exclusions, domains: lines(excluded) }, contact_titles: lines(titles), contacts_per_account: perAccount, playbook_id: ipp.playbook_id,
  });
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); router.refresh(); } catch (e) { setMsg(errorText(e)); } };
  return (
    <section className="card">
      <fieldset disabled={!canEdit || !draft} style={{ border: 0, padding: 0 }}>
        <p><label>Name <input aria-label="IPP name" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 320 }} /></label></p>
        <p className="muted small">Vertical {ipp.vertical} · lead types {ipp.lead_types.join(", ")} · buyers {ipp.buyer_types.join(", ")}</p>
        <div className="grid2">
          <label>Contact titles (one per line)<textarea aria-label="Contact titles" value={titles} onChange={(e) => setTitles(e.target.value)} /></label>
          <label>Excluded domains (one per line)<textarea aria-label="Excluded domains" value={excluded} onChange={(e) => setExcluded(e.target.value)} /></label>
        </div>
        <p><label>Contacts per account <input type="number" min={1} max={5} aria-label="Contacts per account" value={perAccount} onChange={(e) => setPerAccount(Number(e.target.value))} /></label></p>
      </fieldset>
      {canEdit && (
        <div className="row">
          {draft && <button onClick={() => run(() => call(`/ipps/${ipp.id}`, { method: "PUT", body: body() }), "Draft saved.")}>Save draft</button>}
          {draft && <button className="primary" onClick={() => run(async () => {
            await call(`/ipps/${ipp.id}`, { method: "PUT", body: body() });
            await call(`/ipps/${ipp.id}/submit`, { body: {} });
          }, "Submitted for approval.")}>Save &amp; submit</button>}
          {ipp.status === "active" && <button onClick={async () => {
            try { const r = await call<{ id: string }>(`/ipps/${ipp.id}/versions`, { body: body() }); router.push(`/setup/ipps/${r.id}`); } catch (e) { setMsg(errorText(e)); }
          }}>Create new version</button>}
          {ipp.status === "active" && <a className="btn" href={`/sourcing?ipp=${ipp.id}`}>Start a sourcing run</a>}
          {msg && <span className="small" role="status">{msg}</span>}
        </div>
      )}
    </section>
  );
}
