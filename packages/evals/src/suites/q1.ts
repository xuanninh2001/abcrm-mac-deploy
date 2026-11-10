import { evaluatePlaybook, type AccountFacts, type EvalCriterion, type EvidenceItem } from "@abcrm/qualification";
import { expandPlaybookTemplate, loadPack } from "@abcrm/setup";
import type { LlmGateway } from "@abcrm/llm";
import { listFiles, readJsonl, DATASETS_DIR } from "../datasets.js";
import { ratio, type SuiteResult } from "../metrics.js";

/**
 * A golden-set row (test-plan.md §5.1, from design partners): the account facts and page evidence the engine
 * would see, plus the partner's label. `playbook` is a template key of `pack`.
 */
export type GoldenSample = {
  pack: string; playbook: string; domain: string; label: "fit" | "not_fit";
  account: Omit<AccountFacts, "name" | "domain"> & { name?: string };
  evidence: EvidenceItem[];
};

export const toEvalCriteria = (c: ReturnType<typeof expandPlaybookTemplate>["criteria"]): EvalCriterion[] => c.map((x, i) => ({
  key: x.key, name: x.name, description: x.description, hints: x.hints, kind: x.kind, evaluation: x.evaluation, weight: x.weight,
  evidenceRequired: x.evidence_required, unknownPolicy: x.unknown_policy, unknownPenalty: x.unknown_penalty, orderNo: i, rule: x.rule,
}));

/**
 * Q1 on the golden set with a real model (nightly, or on PRs that change prompts, packs or model mapping):
 * Tier A precision ≥ 0.70, Tier D recall on not-fit ≥ 0.80, unverified-quote rate before filtering ≤ 0.05.
 * Skipped without a model or without golden files (datasets/golden/*.jsonl; see datasets/golden/README.md).
 */
export async function runQ1(llm: LlmGateway | null, opts: { dir?: string; limit?: number } = {}): Promise<SuiteResult> {
  const files = await listFiles(opts.dir ?? `${DATASETS_DIR}/golden`);
  if (!llm) return { suite: "q1", metrics: [], failures: [], skipped: "no model configured (set ANTHROPIC_API_KEY and pass --live)" };
  if (!files.length) return { suite: "q1", metrics: [], failures: [], skipped: "no golden set yet (datasets/golden/*.jsonl)" };
  const samples = (await Promise.all(files.map((f) => readJsonl<GoldenSample>(f)))).flat().slice(0, opts.limit ?? Infinity);
  let predA = 0, predAFit = 0, notFit = 0, notFitD = 0, quotes = 0, unverified = 0;
  const failures: string[] = [];
  for (const s of samples) {
    const pack = await loadPack(s.pack);
    const pb = expandPlaybookTemplate(pack, s.playbook, s.playbook);
    const out = await evaluatePlaybook({
      criteria: toEvalCriteria(pb.criteria), thresholds: pb.tier_thresholds, cardMinTier: pb.card_min_tier,
      account: { ...s.account, name: s.account.name ?? s.domain, domain: s.domain }, contacts: { email_status: [] },
      evidence: s.evidence, llm,
    });
    const tier = out.score.tier;
    quotes += out.totalQuotes;
    unverified += out.unverifiedQuotes;
    if (tier === "A") { predA++; if (s.label === "fit") predAFit++; else failures.push(`${s.domain}: Tier A but labelled not_fit`); }
    if (s.label === "not_fit") { notFit++; if (tier === "D") notFitD++; else failures.push(`${s.domain}: not_fit but Tier ${tier}`); }
  }
  return {
    suite: "q1",
    metrics: [
      { key: "q1.tier_a_precision", value: ratio(predAFit, predA), min: 0.7, n: predA },
      { key: "q1.tier_d_recall_not_fit", value: ratio(notFitD, notFit), min: 0.8, n: notFit },
      { key: "q1.unverified_quote_rate", value: ratio(unverified, quotes), max: 0.05, n: quotes },
    ],
    failures,
  };
}
