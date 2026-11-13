import { providerJson } from "@abcrm/core";
import type { SearchProvider, SearchQuery, SearchResult } from "./search.js";

export class TavilySearch implements SearchProvider {
  readonly name = "tavily";
  constructor(private readonly apiKey: string) {}
  async search(q: SearchQuery): Promise<SearchResult[]> {
    const body = await providerJson("https://api.tavily.com/search", {
      method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: q.query, search_depth: "basic", max_results: Math.min(Math.max(q.limit ?? 10, 1), 20),
        include_answer: false, include_raw_content: false,
        ...(q.recencyDays ? { time_range: q.recencyDays <= 1 ? "day" : q.recencyDays <= 7 ? "week" : q.recencyDays <= 31 ? "month" : "year" } : {}) }),
    }, "Tavily") as { results?: { url: string; title: string; content?: string }[] };
    if (!Array.isArray(body?.results)) throw new Error("Tavily returned an invalid result list.");
    return body.results.filter(r => r && typeof r.url === "string" && /^https?:\/\//i.test(r.url) && typeof r.title === "string")
      .map(r => ({ url: r.url, title: r.title, snippet: typeof r.content === "string" ? r.content : "" }));
  }
}

/** Try the next enabled provider on failure, not when a valid search returns no matches. */
export class SearchWaterfall implements SearchProvider {
  readonly name = "workspace";
  constructor(private readonly providers: SearchProvider[]) {}
  async search(query: SearchQuery): Promise<SearchResult[]> {
    const failures: string[] = [];
    for (const provider of this.providers) {
      try { return await provider.search(query); }
      catch { failures.push(provider.name); }
    }
    throw new Error(`Search sources unavailable (${failures.join(", ")}). Check keys and quotas in Sources.`);
  }
}
