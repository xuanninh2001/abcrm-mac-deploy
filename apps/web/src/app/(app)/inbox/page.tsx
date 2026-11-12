import { api, me } from "@/lib/api";
import type { CardRow } from "@/lib/types";
import { InboxTable } from "@/components/InboxTable";

export const dynamic = "force-dynamic";

/** Decision Inbox, table view (decision-inbox.md §1.2): grouped by IPP, select rows, approve selected. */
export default async function Inbox({ searchParams }: { searchParams: Promise<{ mine?: string; snoozed?: string }> }) {
  const sp = await searchParams;
  const q = new URLSearchParams({ limit: "200", ...(sp.mine ? { mine: "true" } : {}), ...(sp.snoozed ? { include_snoozed: "true" } : {}) });
  const [cards, user] = await Promise.all([api<{ data: CardRow[] }>(`/cards?${q}`), me()]);
  const overdue = cards.data.filter((c) => c.sla_due_at && new Date(c.sla_due_at) < new Date()).length;
  return (
    <>
      <div className="spread page-heading">
        <div><p className="eyebrow">REVIEW &amp; DECIDE</p><h1>Inbox</h1><p className="muted">Review qualified buyers and choose your next connection.</p></div>
        <nav className="filter-tabs" aria-label="Inbox filters">
          <a href="/inbox" aria-current={!sp.mine && !sp.snoozed ? "page" : undefined}>All</a>
          <a href="/inbox?mine=1" aria-current={sp.mine ? "page" : undefined}>Mine</a>
          <a href="/inbox?snoozed=1" aria-current={sp.snoozed ? "page" : undefined}>Include snoozed</a>
        </nav>
      </div>
      <div className="inbox-summary" aria-label="Queue summary">
        <div><span>In this queue</span><strong>{cards.data.length}<small>cards</small></strong></div>
        <div><span>Top qualified</span><strong>{cards.data.filter((c) => c.tier === "A").length}<small>Tier A</small></strong></div>
        <div><span>Needs attention</span><strong className={overdue ? "error" : undefined}>{overdue}<small>past SLA</small></strong></div>
      </div>
      <details className="keyboard-help"><summary>Review keyboard shortcuts</summary><p className="muted small">
        Open a card to review it (<span className="kbd">A</span> approve, <span className="kbd">Shift</span>+<span className="kbd">A</span> approve without email,
        <span className="kbd">R</span> reject, <span className="kbd">S</span> snooze, <span className="kbd">J</span>/<span className="kbd">K</span> next/previous).
      </p></details>
      <InboxTable cards={cards.data} me={user.actor.id} />
    </>
  );
}
