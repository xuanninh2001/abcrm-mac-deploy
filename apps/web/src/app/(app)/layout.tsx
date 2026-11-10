import type { ReactNode } from "react";
import Link from "next/link";
import { api, me } from "@/lib/api";
import { PendingDecisionsProvider } from "@/components/PendingDecisions";

export const dynamic = "force-dynamic";

/** Signed-in shell: navigation, unread badge and the current user. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, notes] = await Promise.all([me(), api<{ unread: number }>("/notifications?unread=true&limit=1")]);
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">ABCRM</div>
        <Link href="/inbox">Inbox</Link>
        <Link href="/sourcing">Sourcing</Link>
        <Link href="/setup">Setup</Link>
        <Link href="/agents">Agents</Link>
        <Link href="/usage">Usage</Link>
        {["owner", "admin"].includes(user.role) && <Link href="/imports">Import</Link>}
        <Link href="/team">Team</Link>
        <Link href="/notifications">Notifications {notes.unread > 0 && <span className="count" aria-label={`${notes.unread} unread`}>{notes.unread}</span>}</Link>
        <div className="me">
          <div>{user.user?.name ?? user.user?.email ?? "Signed in"}</div>
          <div>{user.role.replace(/_/g, " ")}</div>
          <form action="/auth/signout" method="post"><button className="small" type="submit">Sign out</button></form>
        </div>
      </nav>
      <main className="main"><PendingDecisionsProvider>{children}</PendingDecisionsProvider></main>
    </div>
  );
}
