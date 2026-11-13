"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Inbox, Search, SlidersHorizontal, Sparkles, Upload, ChartNoAxesCombined, Users, Bell, LockKeyhole } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/inbox", label: "Inbox", icon: "inbox", group: "Workspace" },
  { href: "/sourcing", label: "Sourcing", icon: "search", group: "Workspace" },
  { href: "/setup", label: "Setup", icon: "sliders", group: "Workspace" },
  { href: "/agents", label: "Agents", icon: "spark", group: "Workspace" },
  { href: "/imports", label: "Import", icon: "upload", group: "Workspace", admin: true },
  { href: "/llm", label: "AI / LLM", icon: "spark", group: "Manage", owner: true },
  { href: "/usage", label: "Usage", icon: "chart", group: "Manage" },
  { href: "/team", label: "Team", icon: "team", group: "Manage" },
  { href: "/notifications", label: "Notifications", icon: "bell", group: "Manage" },
  { href: "/password", label: "Change password", icon: "lock", group: "Manage" },
];

function NavIcon({ name }: { name: string }) {
  const icons: Record<string, typeof Inbox> = { inbox: Inbox, search: Search, sliders: SlidersHorizontal, spark: Sparkles, upload: Upload, chart: ChartNoAxesCombined, team: Users, bell: Bell, lock: LockKeyhole };
  const Icon = icons[name] ?? Inbox;
  return <Icon size={19} strokeWidth={1.7} aria-hidden="true" />;
}

export function AppShell({ children, name, role, unread }: { children: ReactNode; name: string; role: string; unread: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = links.find(l => pathname === l.href || pathname.startsWith(`${l.href}/`));
  const canManage = ["owner", "admin"].includes(role);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    const onResize = () => { if (window.innerWidth > 900) setOpen(false); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const navigation = <>
      <div className="sidebar-brand">
        <Link href="/inbox" aria-label="Aurora home"><img src="/brand/dbmg.svg" alt="DBMG" width="125" height="36" /></Link>
        <button className="nav-close" onClick={() => setOpen(false)} aria-label="Close navigation">&times;</button>
      </div>
      <div className="workspace-label"><span className="workspace-monogram">A</span><div><strong>Aurora</strong><span>CRM workspace</span></div></div>
      <nav className="nav" aria-label="Main">
        {["Workspace", "Manage"].map(group => <div className="nav-group" key={group}>
          <p className="nav-heading">{group}</p>
          {links.filter(l => l.group === group && (!l.admin || canManage) && (!l.owner || role === "owner")).map(l => <Link key={l.href} href={l.href}
            onClick={() => setOpen(false)} aria-current={current?.href === l.href ? "page" : undefined}>
            <NavIcon name={l.icon} /><span>{l.label}</span>
            {l.href === "/notifications" && unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</span>}
          </Link>)}
        </div>)}
      </nav>
      <div className="me"><span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><div className="me-details"><strong title={name}>{name}</strong><span>{role.replace(/_/g, " ")}</span></div>
        <form action="/auth/signout" method="post"><button type="submit" aria-label="Sign out" title="Sign out"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h13" /></svg></button></form>
      </div>
  </>;
  return <Dialog.Root open={open} onOpenChange={setOpen}><div className="shell">
    <a className="skip-link" href="#workspace">Skip to content</a>
    <aside className="sidebar desktop-sidebar" aria-label="Workspace navigation">{navigation}</aside>
    <Dialog.Portal>
      <Dialog.Overlay className="nav-backdrop" />
      <Dialog.Content className="sidebar is-open mobile-sidebar" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
        {navigation}
      </Dialog.Content>
    </Dialog.Portal>
    <div className="workspace-content">
      <header className="workspace-header">
        <Dialog.Trigger asChild><button className="nav-toggle" aria-label="Open navigation"><span aria-hidden="true">&#9776;</span></button></Dialog.Trigger>
        <div className="breadcrumb"><span>Aurora</span><span aria-hidden="true">/</span><strong>{current?.label ?? "Workspace"}</strong></div>
        <span className="header-brand">DB MEDIA GROUPS</span>
      </header>
      <main id="workspace" className="main" tabIndex={-1}>{children}</main>
      <footer className="workspace-footer"><span>Aurora CRM</span><span>Digital Business Media Group</span></footer>
    </div>
  </div></Dialog.Root>;
}
