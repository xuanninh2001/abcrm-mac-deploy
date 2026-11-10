import { api } from "@/lib/api";
import { Action } from "@/components/Action";

export const dynamic = "force-dynamic";

type Note = { id: string; kind: string; title: string; body: string; payload: { card_id?: string }; read_at: string | null; created_at: string };

export default async function Notifications() {
  const { data, unread } = await api<{ data: Note[]; unread: number }>("/notifications?limit=100");
  return (
    <>
      <h1>Notifications <span className="muted small">{unread} unread</span></h1>
      {data.length === 0 && <div className="card muted">Nothing yet.</div>}
      {data.map((n) => (
        <div key={n.id} className="card spread" style={{ opacity: n.read_at ? 0.65 : 1 }}>
          <div>
            <strong>{n.title}</strong> <span className="muted small">{new Date(n.created_at).toLocaleString()}</span>
            <div>{n.body} {n.payload.card_id && <a href={`/inbox/${n.payload.card_id}`}>Open card</a>}</div>
          </div>
          {!n.read_at && <Action path={`/notifications/${n.id}/read`}>Mark read</Action>}
        </div>
      ))}
    </>
  );
}
