import { createHash } from "node:crypto";
import { isIP } from "node:net";
import robotsParserModule from "robots-parser";
import { Agent, fetch as httpFetch } from "undici";
import type { Pool } from "@abcrm/db";
import { uuidv7 } from "@abcrm/core";
import { extractHtml } from "./extract.js";
import { guardedLookup, isBlockedAddress } from "./ssrf.js";
import { detectTech, type TechSignals } from "./tech.js";
import { matchesDomainPattern, normalizeUrl, registrableDomain } from "./url.js";

export type FetchOk = {
  status: "ok"; url: string; finalUrl: string; pageId: string; title: string; text: string;
  links: { url: string; text: string }[]; tech: TechSignals; fromCache: boolean;
};
export type FetchDenied = {
  status: "denied_policy" | "denied_robots" | "rate_limited" | "blocked_address" | "not_found" | "unsupported_type" | "too_large" | "error";
  reason: string;
};
export type FetchResult = FetchOk | FetchDenied;

export type FetcherOptions = {
  userAgent: string;            // must identify the bot and link to a contact page
  robotsToken?: string;         // product token matched in robots.txt groups
  allowPrivate?: boolean;       // tests only
  minIntervalMs?: number;       // per-domain politeness (raised by robots crawl-delay)
  maxWaitMs?: number;           // wait for a slot at most this long, else rate_limited
  ttlDays?: number;
  timeoutMs?: number;
  maxBytes?: number;
};

type Robots = { isAllowed(url: string, ua?: string): boolean | undefined; getCrawlDelay(ua?: string): number | undefined };
// robots-parser is CommonJS with an ESM-style d.ts; under NodeNext the default import is the function itself at runtime.
const robotsParser = ((robotsParserModule as unknown as { default?: unknown }).default ?? robotsParserModule) as (url: string, txt: string) => Robots;

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polite, SSRF-safe fetcher for public pages (ADR-014, test-plan §7). Uses the global (non-tenant) pool:
 * the page cache and politeness state are shared and carry no tenant attribution.
 */
export class Fetcher {
  private readonly o: Required<FetcherOptions>;
  private readonly agent: Agent;
  private policyCache: { at: number; rules: { pattern: string; policy: string; min_interval_ms: number | null }[] } | null = null;

  constructor(private readonly pool: Pool, opts: FetcherOptions) {
    this.o = { robotsToken: "ABCRMBot", allowPrivate: false, minIntervalMs: 2000, maxWaitMs: 10_000, ttlDays: 7, timeoutMs: 15_000,
      maxBytes: 5 * 1024 * 1024, ...opts };
    this.agent = new Agent({ connect: { lookup: guardedLookup(this.o.allowPrivate) as never, timeout: this.o.timeoutMs } });
  }

  async close() { await this.agent.close(); }

  async fetch(rawUrl: string, opts: { bypassCache?: boolean } = {}): Promise<FetchResult> {
    let url: URL;
    try { url = normalizeUrl(rawUrl); } catch (e) { return { status: "error", reason: (e as Error).message }; }
    const denied = await this.policyDenied(url);
    if (denied) return denied;

    if (!opts.bypassCache) {
      const cached = await this.fromCache(url);
      if (cached) return cached;
    }

    let current = url;
    for (let hop = 0; hop <= 3; hop++) {
      const pre = (await this.policyDenied(current)) ?? (await this.robotsDenied(current));
      if (pre) return pre;
      const wait = await this.reserveSlot(current.hostname);
      if (wait === null) return { status: "rate_limited", reason: `no slot for ${current.hostname} within ${this.o.maxWaitMs}ms` };
      if (wait > 0) await sleep(wait);

      let res: Awaited<ReturnType<typeof httpFetch>>;
      try {
        res = await httpFetch(current, {
          dispatcher: this.agent, redirect: "manual", signal: AbortSignal.timeout(this.o.timeoutMs),
          headers: { "user-agent": this.o.userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
        });
      } catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code;
        return code === "EBLOCKEDADDR" ? { status: "blocked_address", reason: current.hostname } : { status: "error", reason: (e as Error).message };
      }
      await this.pool.query("UPDATE abcrm.domain_fetch_state SET last_status = $2 WHERE domain = $1", [current.hostname, res.status]);

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        try { current = normalizeUrl(new URL(res.headers.get("location")!, current).toString()); } catch { return { status: "error", reason: "bad redirect" }; }
        continue;
      }
      if (res.status === 404 || res.status === 410) { await res.body?.cancel(); return { status: "not_found", reason: String(res.status) }; }
      if (res.status >= 400) { await res.body?.cancel(); return { status: "error", reason: `HTTP ${res.status}` }; }
      const type = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) { await res.body?.cancel(); return { status: "unsupported_type", reason: type }; }

      const body = await this.readCapped(res.body);
      if (body === null) return { status: "too_large", reason: `> ${this.o.maxBytes} bytes` };
      return this.store(url, current, res.status, body, res.headers.get("etag"));
    }
    return { status: "error", reason: "too many redirects" };
  }

  // --- internals -------------------------------------------------------------------------------

  private async policyDenied(u: URL): Promise<FetchDenied | null> {
    if (isIP(u.hostname.replace(/^\[|\]$/g, "")) && !this.o.allowPrivate && isBlockedAddress(u.hostname.replace(/^\[|\]$/g, ""))) {
      return { status: "blocked_address", reason: u.hostname };
    }
    const rules = await this.crawlPolicy();
    const hit = rules.find((r) => r.policy === "deny" && matchesDomainPattern(u.hostname, r.pattern));
    return hit ? { status: "denied_policy", reason: `${u.hostname} is on the no-crawl list` } : null;
  }

  private async crawlPolicy() {
    if (!this.policyCache || Date.now() - this.policyCache.at > 60_000) {
      const { rows } = await this.pool.query<{ pattern: string; policy: string; min_interval_ms: number | null }>(
        "SELECT domain_pattern AS pattern, policy, min_interval_ms FROM abcrm.crawl_policy");
      this.policyCache = { at: Date.now(), rules: rows };
    }
    return this.policyCache.rules;
  }

  /** RFC 9309: 4xx robots → allowed; 5xx/unreachable → fully disallowed (retry after cache expiry). */
  private async robotsDenied(u: URL): Promise<FetchDenied | null> {
    const origin = u.origin;
    const { rows: [cached] } = await this.pool.query<{ rules: { txt: string; disallowAll?: boolean }; crawl_delay_ms: number | null }>(
      "SELECT rules, crawl_delay_ms FROM abcrm.robots_cache WHERE domain = $1 AND expires_at > now()", [origin]);
    let rules = cached?.rules;
    if (!rules) {
      const fetched = await this.fetchRobots(new URL("/robots.txt", origin));
      if ("blocked" in fetched) return { status: "blocked_address", reason: u.hostname };   // not cached
      rules = fetched;
      const robots = robotsParser(`${origin}/robots.txt`, rules.txt);
      const delay = robots.getCrawlDelay(this.o.robotsToken);
      await this.pool.query(
        `INSERT INTO abcrm.robots_cache(domain, fetched_at, expires_at, rules, crawl_delay_ms) VALUES ($1, now(), now() + interval '1 day', $2, $3)
         ON CONFLICT (domain) DO UPDATE SET fetched_at = now(), expires_at = now() + interval '1 day', rules = $2, crawl_delay_ms = $3`,
        [origin, rules, delay ? Math.min(delay, 60) * 1000 : null]);
    }
    if (rules.disallowAll) return { status: "denied_robots", reason: "robots.txt unavailable (5xx); treated as disallow" };
    const allowed = robotsParser(`${origin}/robots.txt`, rules.txt).isAllowed(u.toString(), this.o.robotsToken);
    return allowed === false ? { status: "denied_robots", reason: `disallowed by ${origin}/robots.txt` } : null;
  }

  private async fetchRobots(robotsUrl: URL): Promise<{ txt: string; disallowAll?: boolean } | { blocked: true }> {
    try {
      const res = await httpFetch(robotsUrl, {
        dispatcher: this.agent, redirect: "follow", signal: AbortSignal.timeout(this.o.timeoutMs), headers: { "user-agent": this.o.userAgent },
      });
      if (res.status >= 500) { await res.body?.cancel(); return { txt: "", disallowAll: true }; }
      if (res.status >= 400) { await res.body?.cancel(); return { txt: "" }; }
      return { txt: ((await this.readCapped(res.body, 500_000)) ?? "").slice(0, 500_000) };
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === "EBLOCKEDADDR") return { blocked: true };
      return { txt: "", disallowAll: true };
    }
  }

  /** Reserves the next request slot for a host across all workers. Returns ms to wait, or null when too far out. */
  private async reserveSlot(host: string): Promise<number | null> {
    const rules = await this.crawlPolicy();
    const slow = rules.find((r) => r.policy === "slow" && matchesDomainPattern(host, r.pattern))?.min_interval_ms;
    const { rows: [robots] } = await this.pool.query<{ crawl_delay_ms: number | null }>(
      "SELECT crawl_delay_ms FROM abcrm.robots_cache WHERE domain LIKE $1 ORDER BY fetched_at DESC LIMIT 1", [`%://${host}`]);
    const interval = Math.max(this.o.minIntervalMs, slow ?? 0, robots?.crawl_delay_ms ?? 0);
    const { rows: [r] } = await this.pool.query<{ wait_ms: number }>(
      `INSERT INTO abcrm.domain_fetch_state(domain, next_allowed_at) VALUES ($1, now() + make_interval(secs => $2::float8 / 1000))
       ON CONFLICT (domain) DO UPDATE SET next_allowed_at = greatest(abcrm.domain_fetch_state.next_allowed_at, now()) + make_interval(secs => $2::float8 / 1000)
       RETURNING greatest(0, extract(epoch FROM (next_allowed_at - make_interval(secs => $2::float8 / 1000) - now())) * 1000)::int AS wait_ms`,
      [host, interval]);
    return r!.wait_ms > this.o.maxWaitMs ? null : r!.wait_ms;
  }

  private async readCapped(body: ReadableStream<Uint8Array> | null, max = this.o.maxBytes): Promise<string | null> {
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async fromCache(url: URL): Promise<FetchOk | null> {
    const { rows: [p] } = await this.pool.query<{ id: string; url: string; title: string | null; content_text: string | null; links: FetchOk["links"]; tech_signals: TechSignals }>(
      `SELECT id, url, title, content_text, links, tech_signals FROM abcrm.public_pages
       WHERE url_hash = $1 AND expires_at > now() AND status_code = 200 AND content_text IS NOT NULL`, [sha256(url.toString())]);
    if (!p) return null;
    return { status: "ok", url: url.toString(), finalUrl: p.url, pageId: p.id, title: p.title ?? "", text: p.content_text ?? "",
      links: p.links, tech: p.tech_signals, fromCache: true };
  }

  private async store(requested: URL, final: URL, statusCode: number, html: string, etag: string | null): Promise<FetchOk> {
    const site = registrableDomain(final);
    const page = extractHtml(html, final, (u) => { try { return registrableDomain(u) === site; } catch { return false; } });
    const tech = detectTech(page.scripts, page.inline);
    const { rows: [row] } = await this.pool.query<{ id: string }>(
      `INSERT INTO abcrm.public_pages(id, url_hash, url, domain, fetched_at, expires_at, status_code, robots_allowed, title, content_text, links, tech_signals, etag)
       VALUES ($1, $2, $3, $4, now(), now() + make_interval(days => $5), $6, true, $7, $8, $9, $10, $11)
       ON CONFLICT (url_hash) DO UPDATE SET url = EXCLUDED.url, fetched_at = now(), expires_at = EXCLUDED.expires_at, status_code = EXCLUDED.status_code,
         title = EXCLUDED.title, content_text = EXCLUDED.content_text, links = EXCLUDED.links, tech_signals = EXCLUDED.tech_signals, etag = EXCLUDED.etag
       RETURNING id`,
      [uuidv7(), sha256(requested.toString()), final.toString(), site, this.o.ttlDays, statusCode, page.title, page.text,
        JSON.stringify(page.links), tech, etag]);
    return { status: "ok", url: requested.toString(), finalUrl: final.toString(), pageId: row!.id, title: page.title, text: page.text,
      links: page.links, tech, fromCache: false };
  }
}
