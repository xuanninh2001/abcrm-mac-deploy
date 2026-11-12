"use client";

import { useState } from "react";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

type Criterion = { key: string; name: string; description: string; kind: string; evaluation: string; rule: unknown; weight: number;
  evidence_required: boolean; unknown_policy: string; unknown_penalty: number; hints: string[] };
export type Playbook = { id: string; lineage_id: string; name: string; version: number; status: string; vertical_pack: string | null;
  tier_thresholds: { A: number; B: number; C: number }; card_min_tier: string; criteria: Criterion[] };

/**
 * Criteria table: kind, weight and unknown policy are editable on drafts; an active version is copied into a new
 * draft. Rules (JSONLogic) and AI descriptions come from the pack and stay as they are here.
 */
export function PlaybookEditor({ playbook, canEdit }: { playbook: Playbook; canEdit: boolean }) {
  const router = useRouter();
  const { busy, runTask } = useTask();
  const [criteria, setCriteria] = useState(playbook.criteria);
  const [thresholds, setThresholds] = useState(playbook.tier_thresholds);
  const [minTier, setMinTier] = useState(playbook.card_min_tier);
  const [failed, setFailed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const draft = playbook.status === "draft";
  const editable = canEdit && draft && !busy;
  const set = (i: number, patch: Partial<Criterion>) => setCriteria((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const body = () => ({
    name: playbook.name, vertical_pack: playbook.vertical_pack ?? undefined, tier_thresholds: thresholds, card_min_tier: minTier,
    criteria: criteria.map((c) => ({ ...c, weight: c.kind === "scored" ? c.weight : 0, rule: c.rule ?? undefined })),
  });
  const run = (fn: () => Promise<unknown>, ok: string) => runTask(async () => { try { await fn(); setFailed(false); setMsg(ok); toast.success(ok); router.refresh(); } catch (e) { setFailed(true); setMsg(errorText(e)); toast.error(errorText(e)); } });

  return (
    <section className="card" aria-label="Criteria">
      <div className="row small">
        Tier thresholds:
        {(["A", "B", "C"] as const).map((t) => (
          <label key={t}>{t} ≥ <input type="number" aria-label={`Threshold ${t}`} disabled={!editable} value={thresholds[t]} style={{ width: 60 }}
            onChange={(e) => setThresholds((x) => ({ ...x, [t]: Number(e.target.value) }))} />%</label>
        ))}
        <label>Card from tier <select aria-label="Card minimum tier" disabled={!editable} value={minTier} onChange={(e) => setMinTier(e.target.value)}>
          {["A", "B", "C"].map((t) => <option key={t}>{t}</option>)}</select></label>
      </div>
      <div className="table-scroll" role="region" aria-label="Playbook criteria" tabIndex={0}><table>
        <thead><tr><th>Criterion</th><th>Kind</th><th>Evaluation</th><th>Weight</th><th>If unknown</th></tr></thead>
        <tbody>
          {criteria.map((c, i) => (
            <tr key={c.key}>
              <td><strong>{c.name}</strong><div className="muted small">{c.description || c.key}</div></td>
              <td><select aria-label={`${c.key} kind`} disabled={!editable} value={c.kind} onChange={(e) => set(i, { kind: e.target.value })}>
                {["knockout", "must_have", "scored"].map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</select></td>
              <td className="small">{c.evaluation === "rule" ? "rule" : "AI with quotes"}</td>
              <td><input type="number" aria-label={`${c.key} weight`} min={0} max={100} style={{ width: 60 }} disabled={!editable || c.kind !== "scored"}
                value={c.kind === "scored" ? c.weight : 0} onChange={(e) => set(i, { weight: Number(e.target.value) })} /></td>
              <td><select aria-label={`${c.key} unknown policy`} disabled={!editable} value={c.unknown_policy} onChange={(e) => set(i, { unknown_policy: e.target.value })}>
                {["neutral", "penalize", "block"].map((k) => <option key={k}>{k}</option>)}</select></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {canEdit && (
        <div className="row" style={{ marginTop: 10 }}>
          {draft && <Button busy={busy} onClick={() => run(() => call(`/playbooks/${playbook.id}`, { method: "PUT", body: body() }), "Draft saved.")}>Save draft</Button>}
          {draft && <Button busy={busy} className="primary" onClick={() => run(async () => {
            await call(`/playbooks/${playbook.id}`, { method: "PUT", body: body() });
            await call(`/playbooks/${playbook.id}/submit`, { body: {} });
          }, "Submitted for approval (the latest preview is attached).")}>Save &amp; submit</Button>}
          {playbook.status === "active" && <Button busy={busy} onClick={() => runTask(async () => {
            try {
              const r = await call<{ id: string }>(`/playbooks/${playbook.id}/versions`, { body: body() });
              router.push(`/setup/playbooks/${r.id}`);
            } catch (e) { setFailed(true); setMsg(errorText(e)); }
          })}>Create new version</Button>}
          {msg && <span className={failed ? "error small" : "small"} role={failed ? "alert" : "status"}>{msg}</span>}
        </div>
      )}
    </section>
  );
}
