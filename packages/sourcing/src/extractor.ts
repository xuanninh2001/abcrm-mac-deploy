import { z } from "zod";
import { normalizeText } from "@abcrm/crypto";
import { LlmOutputError, PLATFORM_RULES, untrusted, type LlmGateway, type LlmUsage } from "@abcrm/llm";
import type { Findings } from "./examine.js";
import type { Fetcher } from "./fetcher.js";

export const S1_INSTRUCTIONS = `Task: read a company's public web pages and extract facts for a lead-generation agency that sells US data leads.
- is_lead_buyer_likely: "yes" only if the pages state that the company buys leads, works with lead vendors/publishers/affiliates, or runs a publisher program; "no" if clearly unrelated; else "unclear".
- is_competitor_likely: "yes" if the company mainly sells or generates the same kind of leads to buyers (a publisher, lead seller or marketplace selling leads to agents).
- buyer_type: one of the listed values, or "unknown".
- lead_types: only keys from the provided list that the pages say the company buys.
- purchase_signals: up to 6 sentences copied verbatim from the pages that show lead buying, each with the page URL.
- hq_country (ISO 3166 alpha-2), hq_state (US 2-letter code), employee_range (e.g. "51-200"): only when stated; otherwise null.`;

const S1Out = z.object({
  is_lead_buyer_likely: z.enum(["yes", "no", "unclear"]),
  is_competitor_likely: z.enum(["yes", "no", "unclear"]),
  buyer_type: z.enum(["direct_brand", "aggregator", "affiliate_network", "ping_post_exchange", "call_buyer", "unknown"]),
  verticals: z.array(z.string()),
  lead_types: z.array(z.string()),
  purchase_signals: z.array(z.object({ evidence_text: z.string(), url: z.string() })),
  hq_country: z.string().nullable(),
  hq_state: z.string().nullable(),
  employee_range: z.string().nullable(),
  injection_suspected: z.boolean(),
});
export type S1Output = z.infer<typeof S1Out>;

const EMPLOYEE_RANGES = new Set(["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"]);

/** S1 extractor (agents.md S1 step c): one small-tier call per domain. Returns null when the model output is unusable. */
export async function extractFindings(llm: LlmGateway, f: Findings, ctx: { vertical: string; leadTypeLabels: Record<string, string> }):
  Promise<{ output: S1Output; usage: LlmUsage } | { output: null; usage: LlmUsage | null }> {
  if (!f.reachable || !f.pages.length) return { output: null, usage: null };
  const user = [
    `Vertical: ${ctx.vertical}. Lead type keys: ${Object.entries(ctx.leadTypeLabels).map(([k, l]) => `${k} (${l})`).join(", ")}.`,
    `Detected tech: ${Object.keys(f.tech).join(", ") || "none"}.`,
    ...f.pages.map((p) => untrusted(p.url, null, p.text)),
  ].join("\n\n");
  try {
    return await llm.generate({ tier: "small", purpose: "s1.extract", system: [PLATFORM_RULES, S1_INSTRUCTIONS], user, schema: S1Out, maxTokens: 2000 });
  } catch (e) {
    if (e instanceof LlmOutputError) return { output: null, usage: e.usage ?? null };
    throw e;
  }
}

/**
 * Combines rule findings with the extractor. Rules stay the floor: a "yes" needs a rule signal or a verified
 * purchase signal; "no" or a competitor verdict skips the domain. Quotes are kept only if they occur in the page text.
 */
export function mergeFindings(f: Findings, out: S1Output | null, leadTypeKeys: string[]): Findings {
  if (!out) return f;
  const verified = out.purchase_signals.slice(0, 6).flatMap((s) => {
    const needle = normalizeText(s.evidence_text);
    if (needle.length < 20 || s.evidence_text.length > 400) return [];
    const page = f.pages.find((p) => p.url === s.url && normalizeText(p.text).includes(needle)) ?? f.pages.find((p) => normalizeText(p.text).includes(needle));
    return page ? [{ url: page.url, pageId: page.pageId, text: s.evidence_text.trim(), kind: "web_page" as const }] : [];
  });
  const snippets = [...f.snippets];
  for (const v of verified) if (!snippets.some((s) => normalizeText(s.text) === normalizeText(v.text))) snippets.push(v);

  const buyer = out.is_lead_buyer_likely === "no" ? false
    : out.is_lead_buyer_likely === "yes" ? f.isLeadBuyerLikely || verified.length > 0
    : f.isLeadBuyerLikely;
  const competitor = out.is_competitor_likely === "yes" || (out.is_competitor_likely === "unclear" && f.isCompetitorLikely);
  const country = out.hq_country?.toUpperCase();
  const state = out.hq_state?.toUpperCase();
  return {
    ...f,
    isLeadBuyerLikely: buyer,
    isCompetitorLikely: competitor,
    leadTypes: [...new Set([...f.leadTypes, ...out.lead_types.filter((k) => leadTypeKeys.includes(k))])],
    snippets: snippets.slice(0, 8),
    injectionSuspected: out.injection_suspected,
    facts: {
      ...(out.buyer_type !== "unknown" ? { buyerType: out.buyer_type } : {}),
      ...(country && /^[A-Z]{2}$/.test(country) ? { hqCountry: country } : state && /^[A-Z]{2}$/.test(state) ? { hqCountry: "US" } : {}),
      ...(state && /^[A-Z]{2}$/.test(state) ? { hqState: state } : {}),
      ...(out.employee_range && EMPLOYEE_RANGES.has(out.employee_range) ? { employeeRange: out.employee_range } : {}),
    },
  };
}

const HINT_PATHS: Record<string, string[]> = {
  home: ["/"], about: ["/about", "/company", "/who-we-are"], partners: ["/partners", "/partner", "/affiliates", "/affiliate"],
  publishers: ["/publishers", "/publisher", "/lead-vendors", "/vendors", "/become-a-vendor", "/affiliates"], careers: ["/careers", "/jobs", "/join"],
  compliance: ["/compliance", "/tcpa", "/privacy"], pricing: ["/pricing", "/rates"], blog: ["/blog", "/news"],
};

/** PageSource for Q1 targeted fetches: the home page plus linked pages whose path matches the criterion hints. */
export function fetcherPageSource(fetcher: Fetcher, siteUrl?: (domain: string) => string) {
  return {
    async pagesFor(domain: string, hints: string[], maxPages: number) {
      const homeUrl = siteUrl ? siteUrl(domain) : `https://${domain}/`;
      let home = await fetcher.fetch(homeUrl);
      if (home.status !== "ok" && !siteUrl) home = await fetcher.fetch(`https://www.${domain}/`);
      if (home.status !== "ok") return [];
      const out = [{ url: home.finalUrl, pageId: home.pageId, text: home.text }];
      const paths = hints.flatMap((h) => HINT_PATHS[h] ?? []).filter((p) => p !== "/");
      const links = home.links.filter((l) => {
        try { return paths.some((p) => new URL(l.url).pathname.toLowerCase().startsWith(p)); } catch { return false; }
      });
      for (const l of [...new Map(links.map((x) => [x.url, x])).values()].slice(0, Math.max(0, maxPages - 1))) {
        const r = await fetcher.fetch(l.url);
        if (r.status === "ok") out.push({ url: r.finalUrl, pageId: r.pageId, text: r.text });
      }
      return out;
    },
  };
}
