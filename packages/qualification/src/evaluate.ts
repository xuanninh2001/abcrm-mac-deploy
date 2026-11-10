import { z } from "zod";
import { LlmOutputError, PLATFORM_RULES, untrusted, type LlmGateway, type LlmUsage } from "@abcrm/llm";
import { verifyQuotes } from "./quotes.js";
import { evaluateRule, type RuleFacts } from "./rules.js";
import { finalizeScorecard, tierAtLeast, type ScoreResult } from "./scoring.js";
import type { CriterionDef, CriterionOutcome, Result, Tier, TierThresholds, VerifiedQuote } from "./types.js";

export type EvalCriterion = CriterionDef & { name: string; description: string; hints: string[] };
export type EvidenceItem = { id: string; kind: string; url: string | null; snippet: string };
export type AccountFacts = RuleFacts["account"] & { name: string; domain: string };

/** Durable step wrapper (DBOS.runStep in the worker); identity otherwise. */
export type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type EvalInput = {
  criteria: EvalCriterion[];
  thresholds: TierThresholds;
  cardMinTier: Tier;
  account: AccountFacts;
  contacts: RuleFacts["contacts"];
  evidence: EvidenceItem[];
  llm: LlmGateway | null;
  /** Stable prompt layer [3]: vertical pack and supply profile summary (cache key: tenant + versions). */
  contextBlock?: string;
  step?: Step;
  /** Prefix for step names, unique per evaluation (e.g. "q1"). */
  stepPrefix?: string;
};

export type CriterionEval = {
  key: string;
  result: Result;
  confidence: number | null;
  rationale: string | null;
  quotes: VerifiedQuote[];
  flags: string[];
};

export type EvalOutput = {
  score: ScoreResult;
  results: CriterionEval[];
  usages: { purpose: string; usage: LlmUsage }[];
  aiUsed: boolean;
  injectionSuspected: boolean;
  unverifiedQuotes: number;
  totalQuotes: number;
  summary: { whyFit: string[]; risks: string[] } | null;
};

export const BATCH_SIZE = 4;
const KIND_ORDER = { knockout: 0, must_have: 1, scored: 2 } as const;

export const Q1_INSTRUCTIONS = `Task: judge whether a company meets qualification criteria defined by a lead-generation agency (the user of this CRM) that wants to sell data leads to the company.

For each requested criterion return exactly one result:
- "pass": the evidence clearly states facts that satisfy the criterion.
- "fail": the evidence clearly states facts that contradict it.
- "unknown": evidence is missing, indirect or ambiguous. Unknown is a valid and preferred answer when evidence is thin.
Support every pass or fail with 1–3 quotes copied verbatim from the evidence blocks (cite evidence_id). Quotes longer than 400 characters are rejected.
Rationale: at most 2 short sentences in neutral English. Confidence: 0 to 1.
Do not score the company; points and tiers are computed elsewhere.`;

const Judgement = z.object({
  results: z.array(z.object({
    criterion_key: z.string(),
    result: z.enum(["pass", "fail", "unknown"]),
    confidence: z.number(),
    rationale: z.string(),
    quotes: z.array(z.object({ evidence_id: z.string(), text: z.string() })),
  })),
  injection_suspected: z.boolean(),
});

const Summary = z.object({ why_fit: z.array(z.string()), risks: z.array(z.string()) });

export function playbookBlock(criteria: EvalCriterion[]): string {
  const ai = criteria.filter((c) => c.evaluation === "ai_judged");
  return `Qualification criteria (playbook):\n${ai.map((c) => `- ${c.key} [${c.kind}]: ${c.name}. ${c.description}`).join("\n")}`;
}

function accountBlock(a: AccountFacts): string {
  const facts = { name: a.name, domain: a.domain, hq_country: a.hq_country ?? null, hq_state: a.hq_state ?? null, employee_range: a.employee_range ?? null,
    buyer_type: a.buyer_type ?? null, verticals: a.verticals, lead_types: a.lead_types, tech_detected: Object.keys(a.tech_signals) };
  return untrusted("crm_account", null, JSON.stringify(facts));
}

export const sortCriteria = <T extends CriterionDef>(cs: T[]) => [...cs].sort((a, b) =>
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.evaluation === b.evaluation ? 0 : a.evaluation === "rule" ? -1 : 1) || a.orderNo - b.orderNo);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Q1 core (agents.md Q1 steps 1–4): rule criteria in code, AI criteria in batches with verbatim quotes,
 * early stop on knockout/must-have failure, deterministic finalize. The LLM never sets points or tier.
 */
export async function evaluatePlaybook(input: EvalInput): Promise<EvalOutput> {
  const step: Step = input.step ?? ((_n, fn) => fn());
  const prefix = input.stepPrefix ?? "eval";
  const ordered = sortCriteria(input.criteria);
  const results = new Map<string, CriterionEval>();
  const usages: EvalOutput["usages"] = [];
  let injectionSuspected = false;
  let unverifiedQuotes = 0;
  let totalQuotes = 0;
  let aiUsed = false;
  const stopped = () => [...results.values()].some((r) => {
    const c = input.criteria.find((x) => x.key === r.key)!;
    return r.result === "fail" && (c.kind === "knockout" || c.kind === "must_have");
  });

  // 1. Rules (cheap, deterministic) first.
  for (const c of ordered.filter((x) => x.evaluation === "rule")) {
    let result: Result;
    const flags: string[] = [];
    try { result = evaluateRule(c.rule, { account: input.account, contacts: input.contacts }); } catch { result = "unknown"; flags.push("rule_error"); }
    results.set(c.key, { key: c.key, result, confidence: null, rationale: null, quotes: [], flags });
  }

  // 2. AI criteria in kind order, ≤ BATCH_SIZE per call.
  const ai = ordered.filter((x) => x.evaluation === "ai_judged");
  const evidenceIds = new Set(input.evidence.map((e) => e.id));
  const system = [PLATFORM_RULES, Q1_INSTRUCTIONS, ...(input.contextBlock ? [input.contextBlock] : []), playbookBlock(input.criteria)];
  const evidenceText = input.evidence.map((e) => untrusted(e.kind === "tech_signal" ? "tech_detector" : e.url ?? e.kind, e.id, e.snippet)).join("\n");
  for (let i = 0; i < ai.length; i += BATCH_SIZE) {
    const batch = ai.slice(i, i + BATCH_SIZE);
    if (stopped()) {
      for (const c of batch) results.set(c.key, { key: c.key, result: "skipped", confidence: null, rationale: null, quotes: [], flags: ["stopped_early"] });
      continue;
    }
    if (!input.llm || input.evidence.length === 0) {
      const flag = input.llm ? "no_evidence" : "llm_unavailable";
      for (const c of batch) results.set(c.key, { key: c.key, result: "unknown", confidence: null, rationale: null, quotes: [], flags: [flag] });
      continue;
    }
    const keys = batch.map((c) => c.key);
    const user = `Company:\n${accountBlock(input.account)}\n\nEvidence:\n${evidenceText}\n\nEvaluate these criteria: ${keys.join(", ")}.`;
    const llm = input.llm;
    const { output, usage } = await step(`${prefix}:judge:${i / BATCH_SIZE}`, async () => {
      try {
        return await llm.generate({ tier: "medium", purpose: "q1.judge", system, user, schema: Judgement, maxTokens: 3000 });
      } catch (e) {
        if (e instanceof LlmOutputError) return { output: null, usage: e.usage ?? null };   // refusal/garbage → unknown, not a crash
        throw e;
      }
    });
    if (usage) usages.push({ purpose: "q1.judge", usage });
    if (!output) {
      for (const c of batch) results.set(c.key, { key: c.key, result: "unknown", confidence: null, rationale: null, quotes: [], flags: ["llm_error"] });
      continue;
    }
    aiUsed = true;
    injectionSuspected ||= output.injection_suspected;
    for (const c of batch) {
      const r = output.results.find((x) => x.criterion_key === c.key);
      if (!r) { results.set(c.key, { key: c.key, result: "unknown", confidence: null, rationale: null, quotes: [], flags: ["not_returned"] }); continue; }
      const raw = r.quotes.slice(0, 5).map((q) => ({ evidenceId: q.evidence_id, text: q.text.slice(0, 400) }));
      const quotes = verifyQuotes(raw.filter((q) => evidenceIds.has(q.evidenceId)), input.evidence)
        .concat(raw.filter((q) => !evidenceIds.has(q.evidenceId)).map((q) => ({ ...q, verified: false })));
      totalQuotes += quotes.length;
      unverifiedQuotes += quotes.filter((q) => !q.verified).length;
      const flags: string[] = [];
      let result: Result = r.result;
      if (result === "pass" && c.evidenceRequired && !quotes.some((q) => q.verified)) { result = "unknown"; flags.push("unverified_pass"); }
      results.set(c.key, {
        key: c.key, result, confidence: Math.min(1, Math.max(0, r.confidence)), rationale: clip(r.rationale, 600),
        quotes: quotes.filter((q) => q.verified), flags,
      });
    }
  }

  // 3. Deterministic finalize.
  const outcomes: CriterionOutcome[] = [...results.values()].map((r) => ({ key: r.key, result: r.result, quotes: r.quotes }));
  const score = finalizeScorecard(input.criteria, outcomes, input.thresholds);

  // 4. Summary for cards only, from verified results.
  let summary: EvalOutput["summary"] = null;
  if (input.llm && aiUsed && tierAtLeast(score.tier, input.cardMinTier)) {
    const verifiedFacts = [...results.values()].filter((r) => r.result === "pass" || r.result === "fail" || r.result === "unknown")
      .map((r) => ({ criterion: r.key, result: r.result, rationale: r.rationale, quotes: r.quotes.map((q) => q.text) }));
    const llm = input.llm;
    const { output, usage } = await step(`${prefix}:summary`, async () => {
      try {
        return await llm.generate({
          tier: "small", purpose: "q1.summary", system: [PLATFORM_RULES],
          user: `Write up to 3 short "why fit" bullets and up to 2 "risks" bullets about ${input.account.name} as a lead buyer, using only these verified criterion results:\n${JSON.stringify(verifiedFacts)}`,
          schema: Summary, maxTokens: 800,
        });
      } catch (e) {
        if (e instanceof LlmOutputError) return { output: null, usage: e.usage ?? null };
        throw e;
      }
    });
    if (usage) usages.push({ purpose: "q1.summary", usage });
    if (output) summary = { whyFit: output.why_fit.slice(0, 3).map((s) => clip(s, 200)), risks: output.risks.slice(0, 2).map((s) => clip(s, 200)) };
  }

  return {
    score, results: input.criteria.map((c) => results.get(c.key) ?? { key: c.key, result: "skipped", confidence: null, rationale: null, quotes: [], flags: [] }),
    usages, aiUsed, injectionSuspected, unverifiedQuotes, totalQuotes, summary,
  };
}

/** Agent credits for one scorecard (pricing doc §1.1). */
export const scorecardCredits = (aiUsed: boolean) => (aiUsed ? 4 : 1);
