import type { EvalCriterion } from "./evaluate.js";

export type Page = { url: string; pageId: string; text: string };
export type Passage = { url: string; pageId: string; text: string };

/** Source of public pages for targeted fetches by criterion hints (implemented on the sourcing Fetcher). */
export interface PageSource {
  pagesFor(domain: string, hints: string[], maxPages: number): Promise<Page[]>;
}

const STOP = new Set(["that", "this", "with", "from", "they", "their", "company", "evidence", "shows", "only", "same", "fail", "pass", "other", "outside", "between"]);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9/-]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);

/**
 * Picks the paragraphs of fetched pages most relevant to the AI criteria, as verbatim evidence snippets
 * (≤ 1,200 chars each). Quotes are verified against these snippets, so they are copied, never rewritten.
 */
export function selectPassages(pages: Page[], criteria: EvalCriterion[], max = 12, perPage = 4): Passage[] {
  const vocab = new Set<string>();
  for (const c of criteria.filter((x) => x.evaluation === "ai_judged")) for (const w of words(`${c.name} ${c.description}`)) vocab.add(w);
  const scored: (Passage & { score: number })[] = [];
  for (const p of pages) {
    const chunks: string[] = [];
    let cur = "";
    for (const para of p.text.split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 30)) {
      if (para.length > 1200) { if (cur) chunks.push(cur); cur = ""; chunks.push(para.slice(0, 1200)); continue; }
      if (cur.length + para.length + 1 > 1200) { chunks.push(cur); cur = para; } else cur = cur ? `${cur}\n${para}` : para;
    }
    if (cur) chunks.push(cur);
    const ranked = chunks.map((text) => {
      const w = words(text);
      let score = 0;
      for (const v of vocab) if (w.has(v)) score++;
      return { url: p.url, pageId: p.pageId, text, score };
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, perPage);
    scored.push(...ranked);
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map(({ score: _s, ...rest }) => rest);
}
