import { normalizeText } from "@abcrm/crypto";
import type { Fetcher, FetchOk } from "./fetcher.js";
import type { TechSignals } from "./tech.js";

/** Tech that indicates a company receives leads from publishers. */
export const BUYER_TECH = new Set(["trustedform", "jornaya", "leadspedia", "boberdoo"]);
const LINK_HINTS = /publisher|partner|affiliate|vendor|lead.?supplier|careers|jobs|compliance/i;

export type ExamineInput = {
  domain: string;
  webPaths: string[];                  // IPP signals.web_paths
  positive: string[];                  // IPP signals.text (pack text_positive)
  negative: string[];                  // IPP exclusions.keywords (pack text_negative)
  leadTypeLabels: Record<string, string>;
  maxExtraPages?: number;
  /** Where a company's site lives; default https://<domain>/ (tests point this at a local server). */
  siteUrl?: (domain: string) => string;
};

export type Snippet = { url: string; pageId: string; text: string; kind: "web_page" };
export type Findings = {
  domain: string;
  name: string;
  reachable: boolean;
  isLeadBuyerLikely: boolean;
  isCompetitorLikely: boolean;
  tech: TechSignals;
  leadTypes: string[];
  snippets: Snippet[];
  pagesFetched: number;
  /** Page text for the S1 extractor (clipped); evidence is still verified against it. */
  pages: { url: string; pageId: string; text: string }[];
  /** Company facts from the S1 extractor; only fill account fields that are empty. */
  facts?: { buyerType?: string; hqCountry?: string; hqState?: string; employeeRange?: string };
  injectionSuspected?: boolean;
  skipReason?: string;
};

export const PAGE_TEXT_LIMIT = 6000;

/** Sentences (≤ 400 chars) of the page that contain any phrase; returned verbatim from the page text. */
export function sentencesWith(text: string, phrases: string[], max = 3): string[] {
  const needles = phrases.map((p) => normalizeText(p)).filter((p) => p.length >= 3);
  const out: string[] = [];
  for (const line of text.split(/\n|(?<=[.!?])\s+/)) {
    const s = line.trim();
    if (s.length < 20 || s.length > 400) continue;
    const n = normalizeText(s);
    if (needles.some((p) => n.includes(p)) && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** "ACA / Health" matches "aca" or "health" as whole words; parts shorter than 3 chars are ignored. */
export function labelMatches(normalizedText: string, label: string): boolean {
  return label.split("/").map((p) => normalizeText(p)).filter((p) => p.length >= 3)
    .some((p) => new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(normalizedText));
}

const titleToName = (title: string, domain: string) => (title.split(/\s[|\-–—:]\s/)[0]?.trim() || domain).slice(0, 120);

/**
 * Deterministic first pass over a company website (home + up to N signal pages). The LLM extractor of S1
 * (Phase 1, with the LLM gateway) adds judgement on top of these findings; evidence is always verbatim page text.
 */
export async function examineDomain(fetcher: Fetcher, input: ExamineInput): Promise<Findings> {
  const empty = (reason: string): Findings => ({ domain: input.domain, name: input.domain, reachable: false, isLeadBuyerLikely: false,
    isCompetitorLikely: false, tech: {}, leadTypes: [], snippets: [], pagesFetched: 0, pages: [], skipReason: reason });
  let home = await fetcher.fetch(input.siteUrl ? input.siteUrl(input.domain) : `https://${input.domain}/`);
  if (home.status !== "ok" && !input.siteUrl) home = await fetcher.fetch(`https://www.${input.domain}/`);
  if (home.status !== "ok") return empty(`home: ${home.status}`);

  const pages: FetchOk[] = [home];
  const candidates = home.links
    .filter((l) => input.webPaths.some((p) => new URL(l.url).pathname.toLowerCase().startsWith(p.toLowerCase())) || LINK_HINTS.test(`${l.url} ${l.text}`))
    .slice(0, input.maxExtraPages ?? 3);
  for (const link of candidates) {
    const r = await fetcher.fetch(link.url);
    if (r.status === "ok") pages.push(r);
  }

  const tech: TechSignals = Object.assign({}, ...pages.map((p) => p.tech));
  const snippets: Snippet[] = [];
  let negativeHits = 0;
  const leadTypes = new Set<string>();
  for (const p of pages) {
    for (const s of sentencesWith(p.text, input.positive)) snippets.push({ url: p.finalUrl, pageId: p.pageId, text: s, kind: "web_page" });
    negativeHits += sentencesWith(p.text, input.negative, 10).length;
    const norm = normalizeText(p.text);
    for (const [key, label] of Object.entries(input.leadTypeLabels)) if (labelMatches(norm, label)) leadTypes.add(key);
  }
  const buyerTech = Object.keys(tech).some((k) => BUYER_TECH.has(k));
  const positive = snippets.length > 0 || buyerTech;
  return {
    domain: input.domain, name: titleToName(home.title, input.domain), reachable: true,
    isLeadBuyerLikely: positive, isCompetitorLikely: negativeHits > 0 && snippets.length === 0,
    tech, leadTypes: [...leadTypes], snippets: snippets.slice(0, 6), pagesFetched: pages.length,
    pages: pages.map((p) => ({ url: p.finalUrl, pageId: p.pageId, text: p.text.slice(0, PAGE_TEXT_LIMIT) })),
  };
}
