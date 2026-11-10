// pnpm --filter @abcrm/evals eval [--suite i1,s2] [--live] [--update-baseline] [--report out.json] [--verbose]
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { llmFromEnv } from "@abcrm/llm";
import { runSuites, SUITES, type SuiteName } from "./run.js";

const { values } = parseArgs({ options: {
  suite: { type: "string" }, live: { type: "boolean", default: false }, "update-baseline": { type: "boolean", default: false },
  report: { type: "string" }, verbose: { type: "boolean", default: false },
} });
const BASELINE = fileURLToPath(new URL("../baseline.json", import.meta.url));
const suites = values.suite?.split(",").map((s) => s.trim()) as SuiteName[] | undefined;
for (const s of suites ?? []) if (!SUITES.includes(s)) throw new Error(`unknown suite ${s} (${SUITES.join(", ")})`);

const baseline = JSON.parse(await readFile(BASELINE, "utf8").catch(() => "{}")) as Record<string, number>;
// The live model is used only when asked: CI on PRs stays deterministic and free.
const report = await runSuites({ suites, llm: values.live ? llmFromEnv() : null, baseline });

for (const s of report.suites) {
  console.log(`\n${s.suite}${s.skipped ? ` (skipped: ${s.skipped})` : ""}`);
  for (const m of s.metrics) {
    const gate = m.min !== undefined ? `≥ ${m.min}` : m.max !== undefined ? `≤ ${m.max}` : "";
    console.log(`  ${m.key.padEnd(36)} ${m.value === null ? "n/a" : m.value.toFixed(3)}  ${gate.padEnd(7)} n=${m.n}`);
  }
  if (s.failures.length) console.log(`  ${s.failures.length} miss(es)${values.verbose ? ":" : " (--verbose to list)"}`);
  if (values.verbose) for (const f of s.failures) console.log(`    - ${f}`);
}
for (const f of [...report.gateFailures, ...report.regressions]) console.error(`FAIL ${f}`);
if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2));
if (values["update-baseline"]) {
  const next = { ...baseline };
  for (const m of report.suites.flatMap((s) => s.metrics)) if (m.value !== null) next[m.key] = Number(m.value.toFixed(4));
  await writeFile(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nbaseline updated: ${BASELINE}`);
}
console.log(report.ok ? "\nevals: ok" : "\nevals: FAILED");
process.exitCode = report.ok ? 0 : 1;
