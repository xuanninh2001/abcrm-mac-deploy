import { api, me } from "@/lib/api";
import type { CardDetail, CardRow, User } from "@/lib/types";
import { CardView } from "@/components/CardView";

export const dynamic = "force-dynamic";

/** Card view (decision-inbox.md §1.1). J/K navigate the same queue as the table view. */
export default async function CardPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await params;
  const [card, queue, user] = await Promise.all([
    api<CardDetail>(`/cards/${cardId}`), api<{ data: CardRow[] }>("/cards?limit=200"), me(),
  ]);
  const canReassign = ["owner", "admin", "head_of_bd"].includes(user.role);
  const users = canReassign ? (await api<{ data: User[] }>("/users")).data : [];
  return <CardView card={card} queue={queue.data.map((c) => c.card_id)} canDecide={user.role !== "viewer"} users={users} />;
}
