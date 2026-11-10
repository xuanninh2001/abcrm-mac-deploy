/** Shared metric helpers. A metric with no denominator is `null` (not enough data), never 0 or 1. */
export const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export type Metric = {
  /** e.g. "i1.mapping_accuracy" */
  key: string;
  value: number | null;
  /** Gate from test-plan.md §5.2: value must be ≥ min (or ≤ max). */
  min?: number;
  max?: number;
  /** Number of samples behind the value. */
  n: number;
};

export type SuiteResult = { suite: string; metrics: Metric[]; failures: string[]; skipped?: string };

export function gateFailures(m: Metric): string[] {
  if (m.value === null) return m.min !== undefined || m.max !== undefined ? [`${m.key}: no samples`] : [];
  const out: string[] = [];
  if (m.min !== undefined && m.value < m.min) out.push(`${m.key} = ${m.value.toFixed(3)} < gate ${m.min}`);
  if (m.max !== undefined && m.value > m.max) out.push(`${m.key} = ${m.value.toFixed(3)} > gate ${m.max}`);
  return out;
}

/** Regression check against the stored baseline: a drop of more than `tolerance` (3 points) fails (test-plan.md §5.3). */
export function regressions(current: Metric[], baseline: Record<string, number>, tolerance = 0.03): string[] {
  const out: string[] = [];
  for (const m of current) {
    const b = baseline[m.key];
    if (b === undefined || m.value === null) continue;
    const worse = m.max !== undefined ? m.value - b : b - m.value;   // for "max" metrics lower is better
    if (worse > tolerance + 1e-9) out.push(`${m.key} regressed: ${b.toFixed(3)} → ${m.value.toFixed(3)}`);
  }
  return out;
}
