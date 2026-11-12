"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CardRow } from "@/lib/types";
import { call, errorText } from "@/lib/client";
import { usePendingDecisions } from "@/components/PendingDecisions";

type BulkResult = { approved: string[]; skipped: { card_id: string; reason: string }[] };

const sla = (iso: string | null) => {
  if (!iso) return null;
  const h = Math.round((new Date(iso).getTime() - Date.now()) / 3600_000);
  return h < 0 ? <span className="badge bad">{-h}h late</span> : <span className="muted small">due {h}h</span>;
};

/** Grouped review (D8): each selected card is approved with its default selection; changed cards come back as skipped. */
export function InboxTable({ cards: all, me }: { cards: CardRow[]; me: string }) {
  const router = useRouter();
  const { pendingIds } = usePendingDecisions();
  // Cards in their undo window are already decided from the rep's point of view.
  const cards = useMemo(() => all.filter((c) => !pendingIds.has(c.card_id)), [all, pendingIds]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const m = new Map<string, CardRow[]>();
    for (const c of cards) {
      const k = c.group_name ?? "Other";
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()];
  }, [cards]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleGroup = (rows: CardRow[], on: boolean) => setSelected((s) => {
    const n = new Set(s);
    for (const r of rows) if (on) n.add(r.card_id); else n.delete(r.card_id);
    return n;
  });

  async function approveSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    setMessage(null);
    try {
      const hashes = Object.fromEntries(cards.filter((c) => selected.has(c.card_id)).map((c) => [c.card_id, c.content_hash]));
      const r = await call<BulkResult>("/cards/bulk-approve", { body: { card_ids: ids, content_hashes: hashes } });
      setStale(new Set(r.skipped.map((s) => s.card_id)));
      setSelected(new Set(r.skipped.map((s) => s.card_id)));
      setMessage(`${r.approved.length} approved${r.skipped.length ? `, ${r.skipped.length} skipped (changed since loaded: review again)` : ""}.`);
      router.refresh();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!cards.length) return <><div className="card muted empty-state"><strong>No cards waiting.</strong>New buyers appear here after qualification.</div>{message && <p role="status">{message}</p>}</>;
  return (
    <>
      <div className="spread card bulk-toolbar">
        <span>{selected.size} selected</span>
        <div className="row">
          {message && <span role="status" className="small">{message}</span>}
          <button className="primary" disabled={!selected.size || busy} onClick={approveSelected}>Approve selected</button>
        </div>
      </div>
      {groups.map(([name, rows]) => (
        <section key={name} className="card inbox-group" aria-label={name}>
          <div className="spread">
            <h2 style={{ margin: 0 }}>{name} <span className="muted small">· {rows.length} cards · Tier A {rows.filter((r) => r.tier === "A").length}</span></h2>
            <label className="small"><input type="checkbox" onChange={(e) => toggleGroup(rows, e.target.checked)}
              checked={rows.every((r) => selected.has(r.card_id))} /> Select group</label>
          </div>
          <div className="table-scroll" role="region" aria-label="Buyer review queue" tabIndex={0}><table>
            <thead><tr><th></th><th>Company</th><th>Tier</th><th>Top reason</th><th>Contact</th><th>First line (AI)</th><th>Flags</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.card_id} className={selected.has(c.card_id) ? "selected" : undefined}>
                  <td><input type="checkbox" aria-label={`Select ${c.account.name}`} checked={selected.has(c.card_id)} onChange={() => toggle(c.card_id)} /></td>
                  <td><a href={`/inbox/${c.card_id}`}>{c.account.name}</a><div className="muted small">{c.account.domain}</div></td>
                  <td><span className={`badge tier-${c.tier}`}>{c.tier}</span> <span className="muted small">{c.score}%</span></td>
                  <td>{c.top_reason ?? <span className="muted">—</span>}</td>
                  <td>{c.contact.title ?? "—"}<div className="muted small">{c.contact.email_status ?? ""}</div></td>
                  <td className="small">{c.first_line ?? <span className="muted">no draft</span>}</td>
                  <td className="small">
                    {stale.has(c.card_id) && <span className="badge warn">updated, review again</span>}{" "}
                    {sla(c.sla_due_at)}{" "}
                    {c.assignee_user_id && c.assignee_user_id !== me && <span className="badge">assigned</span>}
                    {!c.assignee_user_id && <span className="badge">unassigned</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      ))}
    </>
  );
}
