"use client";
import { useState } from "react";
import { Search, ContactRound, PlugZap, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { call, errorText } from "@/lib/client";

export type SourceConfig = { provider: string; kind: "search" | "contact"; name: string; configured: boolean; enabled: boolean; priority: number; hasApiKey: boolean; usageAllowed: boolean };
export type SourcesData = { sources: SourceConfig[]; environmentFallback: boolean };
export function SourceSettings({ initial }: { initial: SourcesData }) {
  const [data, setData] = useState(initial);
  return <div className="sources-settings">
    <p className="muted small">Changes apply to new searches and contact lookups. Tests use the entered key without saving or importing records.</p>
    {data.environmentFallback && <p className="form-alert">No workspace search configuration saved yet. The worker can use its existing Brave environment key. Saving any search source replaces that fallback with the enabled sources below.</p>}
    {(["search", "contact"] as const).map(kind => <section key={kind} aria-label={kind === "search" ? "Search sources" : "Contact sources"}>
      <h2 className="row">{kind === "search" ? <Search size={20} aria-hidden="true" /> : <ContactRound size={20} aria-hidden="true" />}{kind === "search" ? "Search sources" : "Contact sources"}</h2>
      <p className="small muted">{kind === "search" ? "Find company websites. Lower priority numbers run first; the next enabled source is tried if a request fails." : "Find people at a company domain. Title matching, suppression and contact-credit budgets still apply."}</p>
      <div className="source-grid">{data.sources.filter(s => s.kind === kind).map(source => <SourceEditor key={source.provider} initial={source} onSaved={setData} />)}</div>
    </section>)}
  </div>;
}

function SourceEditor({ initial, onSaved }: { initial: SourceConfig; onSaved: (data: SourcesData) => void }) {
  const [source, setSource] = useState(initial);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [operation, setOperation] = useState("");
  const { busy, runTask } = useTask();
  const change = (patch: Partial<SourceConfig>) => { setSource(s => ({ ...s, ...patch })); setDirty(true); setMessage(null); };
  const run = (test: boolean) => runTask(async () => {
    setOperation(test ? "test" : "save"); setMessage(null);
    try {
      const body = { enabled: source.enabled, priority: source.priority, usageAllowed: source.usageAllowed, apiKey: key || undefined, clearKey };
      if (test) {
        const result = await call<{ message: string; latencyMs: number }>(`/sources/${source.provider}/test`, { body });
        setMessage({ ok: true, text: `${result.message} ${(result.latencyMs / 1000).toFixed(1)}s. Configuration was not saved.` });
      } else {
        const result = await call<SourcesData>(`/sources/${source.provider}`, { method: "PUT", body });
        const saved = result.sources.find(s => s.provider === source.provider)!;
        setSource(saved); setKey(""); setClearKey(false); setDirty(false); onSaved(result);
        setMessage({ ok: true, text: saved.enabled ? "Source enabled for new operations." : "Source disabled for new operations." });
        toast.success(`${source.name} saved.`);
      }
    } catch (error) { setMessage({ ok: false, text: errorText(error) }); }
  });
  return <form className="card source-editor" aria-label={source.name} onSubmit={e => { e.preventDefault(); void run(false); }}>
    <div className="spread"><h3>{source.name}</h3><span className="badge">{dirty ? "Unsaved" : source.configured ? source.enabled ? "Enabled" : "Disabled" : "Not configured"}</span></div>
    <fieldset disabled={busy} className="llm-fields">
      <label className="row"><input type="checkbox" checked={source.enabled} onChange={e => change({ enabled: e.target.checked })} />Enable {source.name}</label>
      <label>API key<input type="password" autoComplete="new-password" value={key} maxLength={4096} placeholder={source.hasApiKey ? "Stored securely; leave blank to keep" : "Enter provider API key"}
        onChange={e => { setKey(e.target.value); setClearKey(false); setDirty(true); setMessage(null); }} /></label>
      <p className="small muted">Keys are encrypted for this workspace. Provider endpoints are fixed; keys are never sent to an arbitrary URL.</p>
      {source.kind === "search" && <label>Priority<input type="number" min={1} max={100} required value={source.priority} onChange={e => change({ priority: Number(e.target.value) })} /></label>}
      {source.kind === "contact" && <>
        <label className="row"><input type="checkbox" checked={source.usageAllowed} onChange={e => change({ usageAllowed: e.target.checked })} />My provider agreement permits importing and using these contacts in this CRM.</label>
        <p className="small muted">Only personal emails marked valid by Hunter are imported. Unknown, catch-all and invalid emails are excluded. No phone numbers or shared contact cache.</p>
      </>}
      {source.hasApiKey && <label className="row"><input type="checkbox" checked={clearKey} disabled={source.enabled} onChange={e => { setClearKey(e.target.checked); setKey(""); setDirty(true); }} />Remove stored key on save (disable source first)</label>}
    </fieldset>
    <div className="row" style={{ marginTop: 20 }}>
      <Button type="submit" className="primary" disabled={busy} busy={busy && operation === "save"}><Save size={16} aria-hidden="true" />Save source</Button>
      <Button disabled={busy || clearKey || (!key && !source.hasApiKey)} busy={busy && operation === "test"} onClick={() => void run(true)}><PlugZap size={16} aria-hidden="true" />Test connection</Button>
    </div>
    <p className="small muted" style={{ marginTop: 12 }}>{source.kind === "search" ? "Testing sends one search and may consume provider quota." : "Testing checks account authentication; it does not import contacts or verify domain-search entitlement."} Provider charges are billed separately; no dollar-cost estimate is recorded for these sources.</p>
    {message && <p className={message.ok ? "llm-feedback" : "error"} role={message.ok ? "status" : "alert"}>{message.text}</p>}
  </form>;
}
