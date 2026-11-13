"use client";
import { useState } from "react";
import { Cable, Download, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { call, errorText } from "@/lib/client";

export type LlmConfig = { mode: "environment" | "9router" | "disabled"; baseUrl: string; model: string; hasApiKey: boolean;
  jsonMode: boolean; inputPrice: number; outputPrice: number; updatedAt: string | null };

export function LlmSettings({ initial }: { initial: LlmConfig }) {
  const [config, setConfig] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [action, setAction] = useState("");
  const [dirty, setDirty] = useState(false);
  const { busy, runTask } = useTask();
  const change = (patch: Partial<LlmConfig>) => { setConfig(c => ({ ...c, ...patch })); setDirty(true); setFeedback(null); };
  const run = (op: "save" | "models" | "test") => runTask(async () => {
    setAction(op); setFeedback(null);
    const body = { mode: config.mode, baseUrl: config.baseUrl, model: config.model, apiKey: apiKey || undefined,
      clearKey, jsonMode: config.jsonMode, inputPrice: config.inputPrice, outputPrice: config.outputPrice };
    try {
      if (op === "save") {
        const saved = await call<LlmConfig>("/llm-settings", { method: "PUT", body });
        setConfig(saved); setApiKey(""); setClearKey(false); setDirty(false);
        setFeedback({ ok: true, text: "Saved. New AI workflows will use this configuration." }); toast.success("LLM settings saved.");
      } else if (op === "models") {
        const result = await call<{ models: string[] }>("/llm-settings/models", { body });
        setModels(result.models); setFeedback({ ok: true, text: `${result.models.length} model IDs loaded. Choose one or enter a combo name.` });
      } else {
        const result = await call<{ model: string; latencyMs: number }>("/llm-settings/test", { body });
        setFeedback({ ok: true, text: `JSON validated from ${result.model} in ${(result.latencyMs / 1000).toFixed(1)}s. ${dirty ? "Save to apply these settings." : "Connection is ready."}` });
      }
    } catch (error) { setFeedback({ ok: false, text: errorText(error) }); }
  });
  return <form className="llm-settings" onSubmit={e => { e.preventDefault(); void run("save"); }}>
    <section className="card">
      <div className="spread"><h2 style={{ marginTop: 0 }}>Connection</h2><span className="badge">{dirty ? "Unsaved changes" : "Saved configuration"}</span></div>
      <fieldset disabled={busy} className="llm-fields">
        <label>Provider<select value={config.mode} onChange={e => change({ mode: e.target.value as LlmConfig["mode"] })}>
          <option value="9router">9router / OpenAI-compatible tunnel</option><option value="environment">Claude from server environment</option><option value="disabled">Disable LLM for new workflows</option>
        </select></label>
        {config.mode === "environment" && <p className="muted small">Uses the Claude credentials and model tiers configured on the worker. Without credentials, AI criteria remain unknown.</p>}
        {config.mode === "disabled" && <p className="muted small">New workflows use the non-AI fallback. Running tasks may finish with their previous configuration.</p>}
        {config.mode === "9router" && <>
          <label>Tunnel URL<input type="url" required placeholder="https://your-router.example.com/v1" value={config.baseUrl} onChange={e => { change({ baseUrl: e.target.value }); setModels([]); }} /></label>
          <p className="muted small">Public HTTPS URL, with or without /v1. The API must be accessible without an interactive Cloudflare login.</p>
          <label>9router API key<input type="password" autoComplete="new-password" value={apiKey} maxLength={4096} placeholder={config.hasApiKey ? "Saved securely; leave blank to keep" : "API key from 9router Endpoint settings"}
            onChange={e => { setApiKey(e.target.value); setClearKey(false); setDirty(true); setFeedback(null); setModels([]); }} /></label>
          <p className="small muted">{config.hasApiKey ? "An encrypted key is stored. Re-enter it when changing the URL." : "The key is encrypted on the server and never returned to this page."}</p>
          <div className="row"><label style={{ flex: 1 }}>Model or combo<input required list="router-models" placeholder="Exact model ID from 9router" value={config.model} onChange={e => change({ model: e.target.value })} /></label>
            <Button busy={busy && action === "models"} disabled={busy || !config.baseUrl} onClick={() => void run("models")}><Download size={16} aria-hidden="true" />Load models</Button></div>
          <datalist id="router-models">{models.map(model => <option key={model} value={model} />)}</datalist>
          <p className="small muted">Keep the provider prefix, e.g. cc/ or kr/. One model or combo handles all task tiers; fallback routing stays in 9router.</p>
          <label className="row"><input type="checkbox" checked={config.jsonMode} onChange={e => change({ jsonMode: e.target.checked })} />Request JSON mode (if supported by the provider)</label>
          <p className="small muted">Every response is validated against the CRM schema, even with JSON mode off.</p>
          <details><summary>Estimated cost tracking</summary><p className="small muted">USD per million tokens. Set your provider rates; 0 means no estimated cost recorded, not free usage. Combo estimates use these rates even after model fallback.</p>
            <div className="grid2"><label>Input price<input type="number" min={0} max={10000} step="any" required value={config.inputPrice} onChange={e => change({ inputPrice: Number(e.target.value) })} /></label>
              <label>Output price<input type="number" min={0} max={10000} step="any" required value={config.outputPrice} onChange={e => change({ outputPrice: Number(e.target.value) })} /></label></div>
          </details>
        </>}
        {config.hasApiKey && config.mode !== "9router" && <label className="row"><input type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.target.checked); setDirty(true); }} />Remove saved 9router key when saving</label>}
      </fieldset>
      <div className="row" style={{ marginTop: 24 }}>
        <Button type="submit" className="primary" busy={busy && action === "save"} disabled={busy}><Save size={16} aria-hidden="true" />Save configuration</Button>
        {config.mode === "9router" && <Button busy={busy && action === "test"} disabled={busy || !config.baseUrl || !config.model} onClick={() => void run("test")}><Cable size={16} aria-hidden="true" />Test connection</Button>}
      </div>
      {config.mode === "9router" && <p className="small muted" style={{ marginTop: 12 }}>Test connection sends a small AI request and may consume quota. Testing does not save settings.</p>}
      {feedback && <p className={feedback.ok ? "llm-feedback" : "error"} role={feedback.ok ? "status" : "alert"}>{feedback.text}</p>}
    </section>
  </form>;
}
