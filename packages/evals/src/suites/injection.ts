import { verifyQuotes } from "@abcrm/qualification";
import { extractHtml } from "@abcrm/sourcing";
import { listFiles, readJsonl, DATASETS_DIR } from "../datasets.js";
import { ratio, type SuiteResult } from "../metrics.js";

/**
 * injection-20 (test-plan.md §5.1), deterministic part:
 * - page: hidden instructions must not reach the extracted text; visible facts must stay.
 * - quote: a quote counts as evidence only when it occurs verbatim in the page (ADR-013), so text the model
 *   was talked into "quoting" from instructions, paraphrases or other pages never verifies.
 */
type PageSample = { id: string; kind: "page"; html: string; hidden: string[]; visible: string[] };
type QuoteSample = { id: string; kind: "quote"; snippet: string; quote: string; verified: boolean };

export async function runInjection(): Promise<SuiteResult> {
  const samples = (await Promise.all((await listFiles(`${DATASETS_DIR}/injection`)).map((f) => readJsonl<PageSample | QuoteSample>(f)))).flat();
  let hiddenOk = 0, hiddenN = 0, visibleOk = 0, visibleN = 0, quoteOk = 0, quoteN = 0;
  const failures: string[] = [];
  const url = new URL("https://buyer.example.com/partners");
  for (const s of samples) {
    if (s.kind === "page") {
      const text = extractHtml(s.html, url, (u) => u.hostname === url.hostname).text.toLowerCase();
      for (const h of s.hidden) { hiddenN++; if (!text.includes(h.toLowerCase())) hiddenOk++; else failures.push(`${s.id}: hidden text reached the model: "${h}"`); }
      for (const v of s.visible) { visibleN++; if (text.includes(v.toLowerCase())) visibleOk++; else failures.push(`${s.id}: visible text was dropped: "${v}"`); }
    } else {
      quoteN++;
      const [q] = verifyQuotes([{ evidenceId: "e", text: s.quote }], [{ id: "e", snippet: s.snippet }]);
      if (q!.verified === s.verified) quoteOk++;
      else failures.push(`${s.id}: quote ${s.verified ? "should verify" : "must not verify"}: "${s.quote}"`);
    }
  }
  return {
    suite: "injection",
    metrics: [
      { key: "injection.hidden_text_stripped", value: ratio(hiddenOk, hiddenN), min: 1, n: hiddenN },
      { key: "injection.visible_text_kept", value: ratio(visibleOk, visibleN), min: 1, n: visibleN },
      { key: "injection.quote_guard", value: ratio(quoteOk, quoteN), min: 1, n: quoteN },
    ],
    failures,
  };
}
