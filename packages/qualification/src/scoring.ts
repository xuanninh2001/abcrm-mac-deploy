import { enforceEvidence } from "./quotes.js";
import type { CriterionDef, CriterionOutcome, Result, Tier, TierThresholds } from "./types.js";

export interface ScoreResult {
  tier: Tier;
  pct: number;
  points: number;
  maxPoints: number;
  stoppedAt?: string;
  caps: string[];                      // reasons the tier was capped
  perCriterion: Record<string, { result: Result; points: number }>;
}

const ORDER: Tier[] = ["A", "B", "C", "D"];
const worse = (a: Tier, b: Tier): Tier => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/**
 * Deterministic scorecard finalization (ipp-playbook-format.md §3.1). The LLM only supplies
 * per-criterion results; points and tier are computed here.
 */
export function finalizeScorecard(criteria: CriterionDef[], outcomes: CriterionOutcome[], t: TierThresholds): ScoreResult {
  const byKey = new Map(outcomes.map((o) => [o.key, o]));
  const results = new Map<string, Result>();
  for (const c of criteria) {
    const o = byKey.get(c.key);
    const raw = o?.result ?? "skipped";
    results.set(c.key, raw === "skipped" ? raw : enforceEvidence(raw, c.evidenceRequired, o?.quotes ?? []));
  }
  const perCriterion: ScoreResult["perCriterion"] = {};
  for (const c of criteria) perCriterion[c.key] = { result: results.get(c.key)!, points: 0 };

  const sorted = [...criteria].sort((a, b) => a.orderNo - b.orderNo || a.key.localeCompare(b.key));
  const maxPoints = sorted.filter((c) => c.kind === "scored").reduce((s, c) => s + c.weight, 0);
  const d = (stoppedAt: string | undefined, caps: string[]): ScoreResult => ({ tier: "D", pct: 0, points: 0, maxPoints, stoppedAt, caps, perCriterion });

  // 1. Knockouts
  for (const c of sorted.filter((x) => x.kind === "knockout")) {
    const r = results.get(c.key);
    if (r === "fail") return d(c.key, []);
    if ((r === "unknown" || r === "skipped") && c.unknownPolicy === "block") return d(c.key, [`blocked_unknown:${c.key}`]);
  }

  // 2. Must-haves
  let cap: Tier = "A";
  const caps: string[] = [];
  for (const c of sorted.filter((x) => x.kind === "must_have")) {
    const r = results.get(c.key);
    if (r === "fail") return d(c.key, []);
    if (r !== "pass") { cap = worse(cap, "C"); caps.push(`must_have_unknown:${c.key}`); }
  }

  // 3. Scored
  let points = 0;
  for (const c of sorted.filter((x) => x.kind === "scored")) {
    const r = results.get(c.key);
    let p = 0;
    if (r === "pass") p = c.weight;
    else if (r === "unknown" || r === "skipped") {
      if (c.unknownPolicy === "penalize") p = -c.unknownPenalty;
      if (c.unknownPolicy === "block") { cap = worse(cap, "C"); caps.push(`scored_blocked_unknown:${c.key}`); }
    }
    perCriterion[c.key]!.points = p;
    points += p;
  }

  const pct = maxPoints === 0 ? 100 : Math.round((100 * Math.max(0, points)) / maxPoints);
  const byPct: Tier = pct >= t.A ? "A" : pct >= t.B ? "B" : pct >= t.C ? "C" : "D";
  return { tier: worse(byPct, cap), pct, points, maxPoints, caps, perCriterion };
}

export const tierAtLeast = (tier: Tier, min: Tier) => ORDER.indexOf(tier) <= ORDER.indexOf(min);
