import type { LlmGateway } from "@abcrm/llm";
import { gateFailures, regressions, type SuiteResult } from "./metrics.js";
import { runI1 } from "./suites/i1.js";
import { runInjection } from "./suites/injection.js";
import { runQ1 } from "./suites/q1.js";
import { runS2 } from "./suites/s2.js";
import { runW1 } from "./suites/w1.js";

export const SUITES = ["i1", "s2", "w1", "injection", "q1"] as const;
export type SuiteName = (typeof SUITES)[number];

export type EvalReport = { at: string; suites: SuiteResult[]; gateFailures: string[]; regressions: string[]; ok: boolean };

/** Runs the suites, then applies the gates (test-plan.md §5.2) and the baseline regression check (§5.3). */
export async function runSuites(opts: { suites?: SuiteName[]; llm?: LlmGateway | null; baseline?: Record<string, number> } = {}): Promise<EvalReport> {
  const pick = new Set(opts.suites ?? SUITES);
  const runners: Record<SuiteName, () => Promise<SuiteResult>> = {
    i1: runI1, s2: runS2, w1: runW1, injection: runInjection, q1: () => runQ1(opts.llm ?? null, { dir: process.env.EVAL_GOLDEN_DIR || undefined }),
  };
  const suites: SuiteResult[] = [];
  for (const name of SUITES) if (pick.has(name)) suites.push(await runners[name]());
  const metrics = suites.flatMap((s) => s.metrics);
  const gates = metrics.flatMap(gateFailures);
  const regs = regressions(metrics, opts.baseline ?? {});
  return { at: new Date().toISOString(), suites, gateFailures: gates, regressions: regs, ok: gates.length === 0 && regs.length === 0 };
}
