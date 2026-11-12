"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/inbox", label: "Inbox", icon: "inbox", group: "Workspace" },
  { href: "/sourcing", label: "Sourcing", icon: "search", group: "Workspace" },
  { href: "/setup", label: "Setup", icon: "sliders", group: "Workspace" },
  { href: "/agents", label: "Agents", icon: "spark", group: "Workspace" },
  { href: "/imports", label: "Import", icon: "upload", group: "Workspace", admin: true },
  { href: "/usage", label: "Usage", icon: "chart", group: "Manage" },
  { href: "/team", label: "Team", icon: "team", group: "Manage" },
  { href: "/notifications", label: "Notifications", icon: "bell", group: "Manage" },
  { href: "/password", label: "Change password", icon: "lock", group: "Manage" },
];

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    inbox: <><path d="M4 4h16v16H4z" /><path d="M4 13h5l2 3h2l2-3h5" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    sliders: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6m8 0v6m-8 0v6" /></>,
    spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" /></>,
    chart: <><path d="M4 3v18h17M9 16v-5m5 5V7m5 9V4" /></>,
    team: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3" /></>,
    bell: <><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function AppShell({ children, name, role, unread }: { children: ReactNode; name: string; role: string; unread: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const current = links.find(l => pathname === l.href || pathname.startsWith(`${l.href}/`));
  const canManage = ["owner", "admin"].includes(role);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); menuButton.current?.focus(); }
      if (event.key === "Tab") {
        const nodes = Array.from(drawer.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') ?? []).filter(el => el.getClientRects().length);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const onResize = () => { if (window.innerWidth > 900) setOpen(false); };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => { document.body.style.overflow = previous; document.removeEventListener("keydown", onKey); window.removeEventListener("resize", onResize); };
  }, [open]);
  const close = () => { setOpen(false); menuButton.current?.focus(); };
  return <div className="shell">
    <a className="skip-link" href="#workspace">Skip to content</a>
    {open && <button className="nav-backdrop" aria-label="Close navigation overlay" onClick={close} tabIndex={-1} />}
    <aside ref={drawer} id="app-navigation" className={`sidebar${open ? " is-open" : ""}`} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label="Workspace navigation">
      <div className="sidebar-brand">
        <Link href="/inbox" aria-label="Aurora home"><img src="/brand/dbmg.svg" alt="DBMG" width="125" height="36" /></Link>
        <button className="nav-close" onClick={close} aria-label="Close navigation">&times;</button>
      </div>
      <div className="workspace-label"><span className="workspace-monogram">A</span><div><strong>Aurora</strong><span>CRM workspace</span></div></div>
      <nav className="nav" aria-label="Main">
        {["Workspace", "Manage"].map(group => <div className="nav-group" key={group}>
          <p className="nav-heading">{group}</p>
          {links.filter(l => l.group === group && (!l.admin || canManage)).map(l => <Link key={l.href} href={l.href}
            onClick={() => setOpen(false)} aria-current={current?.href === l.href ? "page" : undefined}>
            <NavIcon name={l.icon} /><span>{l.label}</span>
            {l.href === "/notifications" && unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</span>}
          </Link>)}
        </div>)}
      </nav>
      <div className="me"><span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><div className="me-details"><strong title={name}>{name}</strong><span>{role.replace(/_/g, " ")}</span></div>
        <form action="/auth/signout" method="post"><button type="submit" aria-label="Sign out" title="Sign out"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h13" /></svg></button></form>
      </div>
    </aside>
    <div className="workspace-content" inert={open}>
      <header className="workspace-header">
        <button ref={menuButton} className="nav-toggle" aria-label="Open navigation" aria-expanded={open} aria-controls="app-navigation" onClick={() => setOpen(true)}><span aria-hidden="true">&#9776;</span></button>
        <div className="breadcrumb"><span>Aurora</span><span aria-hidden="true">/</span><strong>{current?.label ?? "Workspace"}</strong></div>
        <span className="header-brand">DB MEDIA GROUPS</span>
      </header>
      <main id="workspace" className="main" tabIndex={-1}>{children}</main>
      <footer className="workspace-footer"><span>Aurora CRM</span><span>Digital Business Media Group</span></footer>
    </div>
  </div>;
}
