import { matchTitle, titleGroups } from "@abcrm/contactdata";
import { loadPack } from "@abcrm/setup";
import { listFiles, readJsonl, DATASETS_DIR } from "../datasets.js";
import { ratio, type SuiteResult } from "../metrics.js";

/** A real-world title and whether a rep would want it for this pack's primary contact titles. */
type Sample = { pack: string; title: string; relevant: boolean };

/**
 * S2 title match (agents.md S2): a contact is chosen when its title matches "exact" or "close".
 * Precision of those choices is gated (≥ 0.85); recall is reported.
 */
export async function runS2(): Promise<SuiteResult> {
  const samples = (await Promise.all((await listFiles(`${DATASETS_DIR}/s2`)).map((f) => readJsonl<Sample>(f)))).flat();
  let tp = 0, fp = 0, fn = 0;
  const failures: string[] = [];
  for (const s of samples) {
    const pack = await loadPack(s.pack);
    const m = matchTitle(s.title, titleGroups(pack.contact_titles.primary, pack.contact_titles.synonyms));
    const chosen = m === "exact" || m === "close";
    if (chosen && s.relevant) tp++;
    else if (chosen) { fp++; failures.push(`${s.pack}: "${s.title}" matched (${m}) but is not relevant`); }
    else if (s.relevant) { fn++; failures.push(`${s.pack}: "${s.title}" is relevant but matched ${m}`); }
  }
  return {
    suite: "s2",
    metrics: [
      { key: "s2.title_precision", value: ratio(tp, tp + fp), min: 0.85, n: tp + fp },
      { key: "s2.title_recall", value: ratio(tp, tp + fn), n: tp + fn },
    ],
    failures,
  };
}
