"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CardDetail, User } from "@/lib/types";
import { call, errorText } from "@/lib/client";
import { aiSegments, cardKey, nextMorning, parseSummary, REJECT_REASONS } from "@/lib/text";
import { usePendingDecisions } from "@/components/PendingDecisions";

const ICON: Record<string, string> = { pass: "✔", fail: "✖", unknown: "?", skipped: "–" };

export function CardView({ card, queue, canDecide, users }: { card: CardDetail; queue: string[]; canDecide: boolean; users: User[] }) {
  const router = useRouter();
  const { defer, pendingIds } = usePendingDecisions();
  const waiting = pendingIds.has(card.card_id);   // decided here a moment ago, still in its undo window
  const pending = card.status === "pending" && !waiting;
  const [contacts, setContacts] = useState<Set<string>>(new Set(card.contacts.filter((c) => c.preselected).map((c) => c.id)));
  const [sendEmail, setSendEmail] = useState(!!card.email_draft);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(card.email_draft?.subject ?? "");
  const [body, setBody] = useState(card.email_draft?.body ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  // Review time (exit criterion: median < 30 s per card): from opening this card to the decision.
  const openedAt = useRef(0);
  useEffect(() => { openedAt.current = performance.now(); }, [card.card_id]);
  const reviewMs = () => Math.min(3_600_000, Math.max(0, Math.round(performance.now() - openedAt.current)));

  // Cards decided a moment ago are still pending on the server until their undo window ends: skip them.
  const live = useMemo(() => queue.filter((id) => id === card.card_id || !pendingIds.has(id)), [queue, pendingIds, card.card_id]);
  const idx = live.indexOf(card.card_id);
  const nextId = live[idx + 1] ?? live.find((id) => id !== card.card_id) ?? null;
  const prevId = idx > 0 ? live[idx - 1] : null;
  // After a decision the card leaves the queue: go to the following one, or back to the table.
  const goNext = useCallback(() => { router.push(nextId ? `/inbox/${nextId}` : "/inbox"); router.refresh(); }, [router, nextId]);

  // Prefetch the next five cards so opening them is instant (decision-inbox.md §4).
  useEffect(() => {
    for (const id of live.slice(Math.max(0, idx + 1), idx + 6)) router.prefetch(`/inbox/${id}`);
  }, [live, idx, router]);

  const draftChanged = !!card.email_draft && (subject !== card.email_draft.subject || body !== card.email_draft.body);

  const decide = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); goNext(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }, [goNext]);

  // Approve and reject wait UNDO_MS before they are sent (undo from the toast or with U); the rep moves on at once.
  const approve = useCallback((withEmail: boolean) => {
    if (!contacts.size) { setError("Select at least one contact."); return; }
    defer(card.card_id, `Approved ${card.account.name}${withEmail && card.email_draft ? " with the email" : ""}`, `/cards/${card.card_id}/approve`, {
      content_hash: card.content_hash, contact_ids: [...contacts], send_first_email: withEmail && !!card.email_draft,
      ...(withEmail && draftChanged ? { draft: { subject, body } } : {}), review_ms: reviewMs(),
    });
    goNext();
  }, [card, contacts, defer, goNext, draftChanged, subject, body]);

  const reject = () => {
    if (!reason) { setError("Choose a reason."); return; }
    if (reason === "other" && !note.trim()) { setError("Add a note for 'Other'."); return; }
    defer(card.card_id, `Rejected ${card.account.name}`, `/cards/${card.card_id}/reject`, { reason_code: reason, ...(note.trim() ? { note } : {}), review_ms: reviewMs() });
    goNext();
  };
  const snooze = useCallback(() => decide(() => call(`/cards/${card.card_id}/snooze`, { body: { until: nextMorning().toISOString() } })), [card.card_id, decide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = cardKey({ key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, targetTag: (e.target as HTMLElement)?.tagName });
      if (!action) return;
      if (action === "escape") { setRejecting(false); setEditing(false); return; }
      if (action === "next" && nextId) { e.preventDefault(); router.push(`/inbox/${nextId}`); return; }
      if (action === "prev" && prevId) { e.preventDefault(); router.push(`/inbox/${prevId}`); return; }
      if (!pending || !canDecide || busy) return;
      e.preventDefault();
      if (action === "approve") void approve(sendEmail);
      if (action === "approve_no_email") void approve(false);
      if (action === "reject") setRejecting(true);
      if (action === "snooze") void snooze();
      if (action === "edit" && card.email_draft) { setEditing(true); setTimeout(() => subjectRef.current?.focus(), 0); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve, snooze, nextId, prevId, router, pending, canDecide, busy, sendEmail, card.email_draft]);

  const segments = useMemo(() => aiSegments(body, body === card.email_draft?.body ? card.email_draft.ai_spans : []), [body, card.email_draft]);
  const a = card.account;
  const { why, risks } = parseSummary(card.scorecard.summary);

  return (
    <article aria-label={`Card ${a.name}`}>
      <div className="spread">
        <div className="row small"><a href="/inbox">← Inbox</a>{idx >= 0 && <span className="muted">{idx + 1} / {live.length}</span>}</div>
        <div className="row small">
          {prevId && <a href={`/inbox/${prevId}`}>Previous (K)</a>}{nextId && <a href={`/inbox/${nextId}`}>Next (J)</a>}
        </div>
      </div>

      <header className="card">
        <div className="spread">
          <div>
            <h1 style={{ marginBottom: 4 }}>{a.name} <a className="small" href={`https://${a.domain}`} target="_blank" rel="noreferrer noopener">{a.domain}</a></h1>
            <div className="muted small">
              {[a.buyer_type, a.lead_types.join(", "), a.hq_state && `HQ ${a.hq_state}`, a.employee_range && `${a.employee_range} employees`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <div className="row">
            <span className={`badge tier-${card.scorecard.tier}`}>Tier {card.scorecard.tier}</span>
            <span>{card.scorecard.total_score}%</span>
            <span className="muted small">playbook v{card.scorecard.playbook_version}</span>
            {card.status !== "pending" && <span className="badge warn">{card.status}</span>}
          </div>
        </div>
      </header>

      {waiting && <p className="card" role="status">You decided this card a moment ago. It is sent in a few seconds; use Undo in the bar below to change it.</p>}

      {(why.length > 0 || risks.length > 0) && (
        <section className="card grid2" aria-label="Why fit">
          <div><h3>Why fit</h3><ul>{why.map((l) => <li key={l}>{l}</li>)}</ul></div>
          <div><h3>Risks</h3>{risks.length ? <ul>{risks.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="muted">None noted.</p>}</div>
        </section>
      )}

      <section className="card" aria-label="Criteria">
        <h2 style={{ marginTop: 0 }}>Criteria</h2>
        {card.scorecard.criteria.map((c) => <Criterion key={c.key} cardId={card.card_id} c={c} canVerify={pending && canDecide} />)}
      </section>

      <section className="card" aria-label="Contacts">
        <h2 style={{ marginTop: 0 }}>Contacts</h2>
        {card.contacts.map((c) => (
          <label key={c.id} className="row" style={{ padding: "4px 0" }}>
            <input type="checkbox" disabled={!pending || c.status !== "active"} checked={contacts.has(c.id)}
              onChange={() => setContacts((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
            <strong>{[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}</strong>
            <span>{c.title}</span>
            <span className="muted small">{c.email}</span>
            <span className={`badge ${c.email_status === "valid" ? "" : "warn"}`}>{c.email_status ?? "unverified"}</span>
            {c.linkedin_url && <a className="small" href={c.linkedin_url} target="_blank" rel="noreferrer noopener">LinkedIn</a>}
          </label>
        ))}
      </section>

      <section className="card" aria-label="First email">
        <div className="spread">
          <h2 style={{ margin: 0 }}>First email</h2>
          {card.email_draft && pending && (
            <div className="row">
              <label className="small"><input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} /> Approve email now</label>
              <button onClick={() => setEditing((v) => !v)}>{editing ? "Preview" : "Edit (E)"}</button>
            </div>
          )}
        </div>
        {!card.email_draft && <p className="muted">No draft: the writer could not produce one that passed the checks. Approve the contact and write the email yourself.</p>}
        {card.email_draft && editing && (
          <div>
            <p><input ref={subjectRef} aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: "100%" }} /></p>
            <textarea aria-label="Body" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        )}
        {card.email_draft && !editing && (
          <div>
            <p><strong>{subject}</strong></p>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
              {segments.map((s, i) => (s.ai ? <span key={i} className="ai" title="Written by AI from verified facts">{s.text}</span> : <span key={i}>{s.text}</span>))}
            </pre>
            {draftChanged && <p className="small muted">Edited: approving saves your version.</p>}
          </div>
        )}
      </section>

      {pending && canDecide && (
        <section className="card" aria-label="Actions">
          {error && <p className="error" role="alert">{error}</p>}
          {!rejecting ? (
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => approve(sendEmail)}>Approve &amp; queue <span className="kbd">A</span></button>
              <button disabled={busy} onClick={() => approve(false)}>Approve, no email yet <span className="kbd">⇧A</span></button>
              <button className="danger" disabled={busy} onClick={() => setRejecting(true)}>Reject <span className="kbd">R</span></button>
              <button disabled={busy} onClick={() => snooze()}>Snooze until 9:00 <span className="kbd">S</span></button>
              {users.length > 0 && <Reassign cardId={card.card_id} users={users} current={card.assignee_user_id} />}
            </div>
          ) : (
            <div className="row">
              <select aria-label="Reject reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus>
                <option value="">Reason…</option>
                {REJECT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
              <input aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 260 }} />
              <button className="danger" disabled={busy} onClick={reject}>Reject card</button>
              <button onClick={() => setRejecting(false)}>Cancel</button>
            </div>
          )}
        </section>
      )}

      <footer className="muted small">
        Credits used: {card.credits.agent} agent · {card.credits.contact} contact ·
        {card.sla_due_at && <> SLA {new Date(card.sla_due_at).toLocaleString()} ·</>}
        {" "}Decisions {card.decisions.map((d) => `${d.gate_id} ${d.id.slice(0, 8)} (${d.status})`).join(", ")}
      </footer>
    </article>
  );
}

function Criterion({ cardId, c, canVerify }: { cardId: string; c: CardDetail["scorecard"]["criteria"][number]; canVerify: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(c.result !== "pass");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const verify = async () => {
    try { await call(`/cards/${cardId}/criteria/${c.key}/verify`, { body: { note } }); setNote(""); router.refresh(); } catch (e) { setErr(errorText(e)); }
  };
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
      <button className="small" style={{ border: 0, padding: 0, background: "none" }} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`result-${c.result}`} aria-label={c.result}>{ICON[c.result] ?? "?"}</span> {c.name}
        <span className="muted"> · {c.kind.replace("_", " ")}{c.points ? ` · +${c.points}` : ""}</span>
      </button>
      {open && (
        <div style={{ paddingLeft: 20 }} className="small">
          {c.rationale && <p>{c.rationale}</p>}
          {c.quotes.map((q, i) => (
            <p key={i}>
              <mark className="quote">“{q.text}”</mark>{" "}
              {q.url && <a href={q.url} target="_blank" rel="noreferrer noopener">source</a>}
              {q.retrieved_at && <span className="muted"> · seen {new Date(q.retrieved_at).toLocaleDateString()}</span>}
            </p>
          ))}
          {c.verified_by.map((v) => <p key={v.user_id + v.at} className="muted">Verified by a rep: {v.note}</p>)}
          {c.result === "unknown" && canVerify && (
            <div className="row">
              <input aria-label={`Verification note for ${c.name}`} placeholder="How did you verify it?" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 280 }} />
              <button disabled={!note.trim()} onClick={verify}>Mark as verified by me</button>
              {err && <span className="error">{err}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Reassign({ cardId, users, current }: { cardId: string; users: User[]; current: string | null }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <label className="row small">Assignee
      <select aria-label="Assignee" value={current ?? ""} onChange={async (e) => {
        try { await call(`/cards/${cardId}/reassign`, { body: { user_id: e.target.value } }); router.refresh(); } catch (x) { setErr(errorText(x)); }
      }}>
        <option value="" disabled>Unassigned</option>
        {users.filter((u) => u.role !== "viewer").map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email} ({u.role.replace(/_/g, " ")})</option>)}
      </select>
      {err && <span className="error">{err}</span>}
    </label>
  );
}
