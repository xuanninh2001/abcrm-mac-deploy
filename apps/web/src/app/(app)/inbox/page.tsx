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
      <div className="spread">
        <h1>Inbox</h1>
        <div className="row small">
          <a href="/inbox">All</a> · <a href="/inbox?mine=1">Mine</a> · <a href="/inbox?snoozed=1">Include snoozed</a>
        </div>
      </div>
      <p className="muted small">
        {cards.data.length} cards · {cards.data.filter((c) => c.tier === "A").length} Tier A{overdue ? ` · ${overdue} past SLA` : ""}.
        Open a card to review it (<span className="kbd">A</span> approve, <span className="kbd">Shift</span>+<span className="kbd">A</span> approve without email,
        <span className="kbd">R</span> reject, <span className="kbd">S</span> snooze, <span className="kbd">J</span>/<span className="kbd">K</span> next/previous).
      </p>
      <InboxTable cards={cards.data} me={user.actor.id} />
    </>
  );
}
