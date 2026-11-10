import { proposeMapping, type Purpose } from "@abcrm/importer";
import { listFiles, readJsonl, DATASETS_DIR } from "../datasets.js";
import { ratio, type SuiteResult } from "../metrics.js";

/** One export file's header row and the field each column should map to (null = ignore). */
type Sample = { source: string; purpose: Purpose; expected: Record<string, string | null> };

/** I1 import mapper (agents.md I1): share of columns mapped to the right field or rightly ignored. Gate ≥ 0.90. */
export async function runI1(): Promise<SuiteResult> {
  const samples = (await Promise.all((await listFiles(`${DATASETS_DIR}/i1`)).map((f) => readJsonl<Sample>(f)))).flat();
  let right = 0, total = 0;
  const failures: string[] = [];
  for (const s of samples) {
    const headers = Object.keys(s.expected);
    const got = new Map(proposeMapping(headers, s.purpose).map((m) => [m.source, m.target as string]));
    for (const h of headers) {
      total++;
      const want = s.expected[h] ?? null;
      if ((got.get(h) ?? null) === want) right++;
      else failures.push(`${s.source} (${s.purpose}) "${h}": expected ${want ?? "ignore"}, got ${got.get(h) ?? "ignore"}`);
    }
  }
  return { suite: "i1", metrics: [{ key: "i1.mapping_accuracy", value: ratio(right, total), min: 0.9, n: total }], failures };
}
