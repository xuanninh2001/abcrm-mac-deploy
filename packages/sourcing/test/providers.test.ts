import { afterEach, expect, it, vi } from "vitest";
import { BraveSearch, TavilySearch, SearchWaterfall } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
it("maps Tavily results and sends bounded search requests with Bearer auth", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ url: "https://buyer.example", title: "Buyer", content: "Buying leads" }] })));
  vi.stubGlobal("fetch", fetch);
  expect(await new TavilySearch("secret").search({ query: "buyers", limit: 100, recencyDays: 7 })).toEqual([{ url: "https://buyer.example", title: "Buyer", snippet: "Buying leads" }]);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://api.tavily.com/search");
  expect(init.headers.authorization).toBe("Bearer secret");
  expect(JSON.parse(init.body)).toMatchObject({ max_results: 20, time_range: "week", search_depth: "basic" });
  expect(init.redirect).toBe("error");
});
it("keeps Brave response mapping and hides upstream error bodies", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ web: { results: [{ url: "https://example.com", title: "Example", description: "Snippet" }] } })))
    .mockResolvedValueOnce(new Response("secret key echoed by provider", { status: 401 })));
  expect((await new BraveSearch("secret").search({ query: "test" }))[0]?.snippet).toBe("Snippet");
  await expect(new BraveSearch("secret").search({ query: "test" })).rejects.toThrow("Brave HTTP 401. Check API key, plan and quota.");
});
it("falls back on error but does not retry an empty successful result", async () => {
  const first = { name: "first", search: vi.fn().mockRejectedValue(new Error("offline")) };
  const next = { name: "next", search: vi.fn().mockResolvedValue([]) };
  expect(await new SearchWaterfall([first, next]).search({ query: "test" })).toEqual([]);
  expect(next.search).toHaveBeenCalledTimes(1);
  next.search.mockClear(); first.search.mockResolvedValue([] as never);
  expect(await new SearchWaterfall([first, next]).search({ query: "test" })).toEqual([]);
  expect(next.search).not.toHaveBeenCalled();
});
