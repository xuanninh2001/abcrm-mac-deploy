import { validateDraft } from "@abcrm/inbox";
import { loadPack } from "@abcrm/setup";
import { listFiles, readJsonl, DATASETS_DIR } from "../datasets.js";
import { ratio, type SuiteResult } from "../metrics.js";

/** A draft (human- or model-written) labelled acceptable or not, with the reason category when not. */
type Sample = { pack: string; subject: string; body: string; basis: string[]; fact_keys: string[]; ok: boolean; reason?: string };

/**
 * W1 validator (agents.md W1, code checks): agreement with the labels must be 1.0 and no draft with an
 * avoid-list or promise violation may pass (the model's output is only shown to reps after this check).
 */
export async function runW1(): Promise<SuiteResult> {
  const samples = (await Promise.all((await listFiles(`${DATASETS_DIR}/w1`)).map((f) => readJsonl<Sample>(f)))).flat();
  let agree = 0, leaks = 0, avoidLabelled = 0;
  const failures: string[] = [];
  for (const s of samples) {
    const avoid = ((await loadPack(s.pack)).messaging as { avoid?: string[] } | undefined)?.avoid ?? [];
    const v = validateDraft({ subject: s.subject, body: s.body, aiSpans: [], personalizationBasis: s.basis }, { avoid, factKeys: s.fact_keys });
    const passed = v.length === 0;
    if (passed === s.ok) agree++;
    else failures.push(`${s.pack} "${s.subject}": labelled ${s.ok ? "ok" : `bad (${s.reason})`}, validator ${passed ? "passed it" : `flagged: ${v.join("; ")}`}`);
    if (s.reason === "avoid") { avoidLabelled++; if (passed) leaks++; }
  }
  return {
    suite: "w1",
    metrics: [
      { key: "w1.validator_agreement", value: ratio(agree, samples.length), min: 1, n: samples.length },
      { key: "w1.avoid_violations_passed", value: ratio(leaks, avoidLabelled), max: 0, n: avoidLabelled },
    ],
    failures,
  };
}
