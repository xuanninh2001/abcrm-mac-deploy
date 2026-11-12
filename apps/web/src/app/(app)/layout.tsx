import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { api, me } from "@/lib/api";
import { PendingDecisionsProvider } from "@/components/PendingDecisions";

export const dynamic = "force-dynamic";

/** Signed-in shell: navigation, unread badge and the current user. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user, notes] = await Promise.all([me(), api<{ unread: number }>("/notifications?unread=true&limit=1")]);
  return (
    <AppShell name={user.user?.name ?? user.user?.email ?? "Signed in"} role={user.role} unread={notes.unread}>
      <PendingDecisionsProvider>{children}</PendingDecisionsProvider>
    </AppShell>
  );
}
