import { createHash } from "node:crypto";
import type { Pool } from "@abcrm/db";

export type SearchQuery = { query: string; recencyDays?: number; limit?: number };
export type SearchResult = { url: string; title: string; snippet: string; publishedAt?: string };

export interface SearchProvider {
  readonly name: string;
  search(q: SearchQuery): Promise<SearchResult[]>;
}

/**
 * Brave Search API adapter (provider choice pending the M3 spike; others implement the same interface).
 * Only titles, snippets and URLs are used; result pages are fetched separately through the polite fetcher.
 */
export class BraveSearch implements SearchProvider {
  readonly name = "brave";
  constructor(private readonly apiKey: string, private readonly endpoint = "https://api.search.brave.com/res/v1/web/search") {}

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: q.query, count: String(Math.min(q.limit ?? 10, 20)) });
    if (q.recencyDays) params.set("freshness", q.recencyDays <= 1 ? "pd" : q.recencyDays <= 7 ? "pw" : q.recencyDays <= 31 ? "pm" : "py");
    const res = await fetch(`${this.endpoint}?${params}`, {
      headers: { accept: "application/json", "x-subscription-token": this.apiKey }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`brave search HTTP ${res.status}`);
    const body = (await res.json()) as { web?: { results?: { url: string; title: string; description?: string; page_age?: string }[] } };
    return (body.web?.results ?? []).map((r) => ({ url: r.url, title: r.title, snippet: r.description ?? "", publishedAt: r.page_age }));
  }
}

/** Caches provider responses in the global search_cache (public data, no tenant attribution). */
export class CachedSearch implements SearchProvider {
  readonly name: string;
  constructor(private readonly inner: SearchProvider, private readonly pool: Pool, private readonly ttlDays = 7) { this.name = inner.name; }

  async search(q: SearchQuery): Promise<SearchResult[]> {
    const key = createHash("sha256").update(`${this.inner.name}\u0000${q.query}\u0000${q.recencyDays ?? ""}\u0000${q.limit ?? 10}`).digest();
    const { rows: [hit] } = await this.pool.query<{ results: SearchResult[] }>(
      "SELECT results FROM abcrm.search_cache WHERE query_hash = $1 AND expires_at > now()", [key]);
    if (hit) return hit.results;
    const results = await this.inner.search(q);
    await this.pool.query(
      `INSERT INTO abcrm.search_cache(query_hash, provider, results, fetched_at, expires_at) VALUES ($1, $2, $3, now(), now() + make_interval(days => $4))
       ON CONFLICT (query_hash) DO UPDATE SET results = EXCLUDED.results, fetched_at = now(), expires_at = EXCLUDED.expires_at`,
      [key, this.inner.name, JSON.stringify(results), this.ttlDays]);
    return results;
  }
}

/** Deterministic provider for tests and local demos. */
export class StaticSearch implements SearchProvider {
  readonly name = "static";
  readonly calls: string[] = [];
  constructor(private readonly results: Record<string, SearchResult[]>, private readonly fallback: SearchResult[] = []) {}
  async search(q: SearchQuery): Promise<SearchResult[]> {
    this.calls.push(q.query);
    return this.results[q.query] ?? this.fallback;
  }
}
