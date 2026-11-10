import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { Fetcher, isBlockedAddress, type FetcherOptions } from "../src/index.js";

let t: TestDb;
let server: Server;
let base: string;
const hits = new Map<string, number>();
let robotsMode: "rules" | "404" | "500" = "rules";

const PAGES: Record<string, { status?: number; type?: string; body: string; location?: string }> = {
  "/": { body: `<html><head><title>Acme Health Leads</title><script src="https://api.trustedform.com/trustedform.js?field=xxTrustedFormCertUrl"></script>
    <script>var secret = "inline should not be in text";</script></head><body><h1>Become a lead vendor</h1>
    <p>We buy ACA and final expense leads from publishers via ping post.</p>
    <a href="/publishers">Publishers</a> <a href="https://other.example/x">Other site</a> <a href="mailto:x@y.com">mail</a></body></html>` },
  "/publishers": { body: "<html><body><p>Posting specs: TrustedForm required on every lead.</p></body></html>" },
  "/private/x": { body: "<p>secret</p>" },
  "/huge": { body: "x".repeat(2_000_000) },
  "/pdf": { type: "application/pdf", body: "%PDF" },
  "/to-linkedin": { status: 302, location: "https://www.linkedin.com/company/acme", body: "" },
  "/to-publishers": { status: 301, location: "/publishers", body: "" },
};

beforeAll(async () => {
  t = await setupTestDb();
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/robots.txt") {
      if (robotsMode === "404") { res.writeHead(404).end(); return; }
      if (robotsMode === "500") { res.writeHead(500).end(); return; }
      res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: ABCRMBot\nDisallow: /private\n\nUser-agent: *\nDisallow: /");
      return;
    }
    const p = PAGES[path];
    if (!p) { res.writeHead(404).end(); return; }
    res.writeHead(p.status ?? 200, { "content-type": p.type ?? "text/html; charset=utf-8", ...(p.location ? { location: p.location } : {}) }).end(p.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server?.close(); await t?.close(); });

const make = (o: Partial<FetcherOptions> = {}) =>
  new Fetcher(t.global, { userAgent: "ABCRMBot/0.1 (+https://abcrm.app/bot)", allowPrivate: true, minIntervalMs: 0, maxBytes: 1_000_000, ...o });

describe("SSRF guard", () => {
  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(a), a).toBe(false);
  });

  it("refuses loopback by IP literal and by hostname resolution", async () => {
    const f = make({ allowPrivate: false });
    const port = new URL(base).port;
    expect((await f.fetch(`http://127.0.0.1:${port}/`, { bypassCache: true })).status).toBe("blocked_address");
    expect((await f.fetch(`http://[::1]:${port}/`, { bypassCache: true })).status).toBe("blocked_address");
    expect((await f.fetch(`http://localhost:${port}/publishers`, { bypassCache: true })).status).toBe("blocked_address");
    expect((await f.fetch("file:///etc/passwd")).status).toBe("error");
    await f.close();
  });
});

describe("crawl policy & robots", () => {
  it("never requests no-crawl domains", async () => {
    const f = make();
    expect(await f.fetch("https://www.linkedin.com/posts/someone")).toMatchObject({ status: "denied_policy" });
    expect(await f.fetch("https://LINKEDIN.com/in/x")).toMatchObject({ status: "denied_policy" });
    await f.close();
  });

  it("honours robots.txt groups for our token; a redirect into a denied domain is refused", async () => {
    const f = make();
    expect((await f.fetch(`${base}/private/x`)).status).toBe("denied_robots");
    expect((await f.fetch(`${base}/to-linkedin`)).status).toBe("denied_policy");
    expect(hits.get("/private/x")).toBeUndefined();
    await f.close();
  });

  it("robots 5xx disallows everything; robots 404 allows", async () => {
    await t.admin.query("DELETE FROM abcrm.robots_cache");
    robotsMode = "500";
    const f = make();
    expect((await f.fetch(`${base}/publishers`, { bypassCache: true })).status).toBe("denied_robots");
    await t.admin.query("DELETE FROM abcrm.robots_cache");
    robotsMode = "404";
    expect((await f.fetch(`${base}/private/x`, { bypassCache: true })).status).toBe("ok");
    await t.admin.query("DELETE FROM abcrm.robots_cache");
    robotsMode = "rules";
    await f.close();
  });
});

describe("fetching, extraction, cache", () => {
  it("extracts text, same-site links and tech signals; second fetch is served from cache", async () => {
    const f = make();
    const r = await f.fetch(`${base}/`);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.title).toBe("Acme Health Leads");
    expect(r.text).toContain("We buy ACA and final expense leads from publishers via ping post.");
    expect(r.text).not.toContain("inline should not be in text");
    expect(r.links.map((l) => l.url)).toEqual([`${base}/publishers`]);
    expect(Object.keys(r.tech)).toEqual(["trustedform"]);
    expect(r.fromCache).toBe(false);
    const before = hits.get("/") ?? 0;
    const again = await f.fetch(`${base}/#fragment`);
    expect(again).toMatchObject({ status: "ok", fromCache: true, pageId: r.pageId });
    expect(hits.get("/")).toBe(before);
    await f.close();
  });

  it("follows same-site redirects; caps size; skips non-HTML; maps 404", async () => {
    const f = make();
    expect(await f.fetch(`${base}/to-publishers`, { bypassCache: true })).toMatchObject({ status: "ok", finalUrl: `${base}/publishers` });
    expect((await f.fetch(`${base}/huge`)).status).toBe("too_large");
    expect((await f.fetch(`${base}/pdf`)).status).toBe("unsupported_type");
    expect((await f.fetch(`${base}/missing`)).status).toBe("not_found");
    await f.close();
  });
});

describe("politeness", () => {
  it("spaces requests to the same host across fetcher instances and gives up past maxWait", async () => {
    await t.admin.query("DELETE FROM abcrm.domain_fetch_state");
    const a = make({ minIntervalMs: 400 });
    const b = make({ minIntervalMs: 400, maxWaitMs: 100 });
    const t0 = Date.now();
    await a.fetch(`${base}/publishers`, { bypassCache: true });
    await a.fetch(`${base}/publishers`, { bypassCache: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect((await b.fetch(`${base}/publishers`, { bypassCache: true })).status).toBe("rate_limited");
    await a.close();
    await b.close();
  });

  it("the app role cannot read the global page cache", async () => {
    await expect(t.app.query("SELECT 1 FROM abcrm.public_pages")).rejects.toThrow(/permission denied/);
    await expect(t.app.query("SELECT 1 FROM abcrm.domain_fetch_state")).rejects.toThrow(/permission denied/);
  });
});
