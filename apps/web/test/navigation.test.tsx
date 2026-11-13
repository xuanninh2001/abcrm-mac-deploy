import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/AppShell";
import { PasswordInput } from "../src/components/PasswordInput";

const route = vi.hoisted(() => ({ pathname: "/inbox" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));

describe("Aurora navigation preserves access and account controls", () => {
  it.each(["owner", "admin", "head_of_bd", "sales_rep", "viewer"])("keeps all permitted destinations for %s", role => {
    const html = renderToStaticMarkup(<AppShell name="Test user" role={role} unread={3}><h1>Working content</h1></AppShell>);
    for (const path of ["inbox", "sourcing", "setup", "agents", "usage", "team", "password", "notifications"]) expect(html).toContain(`href="/${path}"`);
    expect(html.includes('href="/imports"')).toBe(["owner", "admin"].includes(role));
    expect(html.includes('href="/llm"')).toBe(role === "owner");
    expect(html).toContain('action="/auth/signout"');
    expect(html).toContain('method="post"');
    expect(html).toContain('aria-label="3 unread"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('id="workspace"');
    expect(html).toContain("Working content");
  });
  it("keeps Setup active on a nested editor route", () => {
    route.pathname = "/setup/playbooks/example";
    const html = renderToStaticMarkup(<AppShell name="Owner" role="owner" unread={0}>Editor</AppShell>);
    expect(html).toMatch(/href="\/setup"[^>]*aria-current="page"/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="0 unread"');
    route.pathname = "/inbox";
  });
  it("password visibility starts masked and its toggle never submits the login form", () => {
    const html = renderToStaticMarkup(<PasswordInput name="password" required autoComplete="current-password" maxLength={256} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Show password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('maxLength="256"');
  });
});
