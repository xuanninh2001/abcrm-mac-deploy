import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScriptedLlm, type LlmRequest } from "@abcrm/llm";
import { gateFailures, regressions, runQ1, runSuites } from "../src/index.js";

describe("metrics", () => {
  it("gates and regressions", () => {
    expect(gateFailures({ key: "a", value: 0.8, min: 0.9, n: 10 })).toEqual(["a = 0.800 < gate 0.9"]);
    expect(gateFailures({ key: "b", value: 0.1, max: 0.05, n: 10 })).toEqual(["b = 0.100 > gate 0.05"]);
    expect(gateFailures({ key: "c", value: null, min: 0.9, n: 0 })).toEqual(["c: no samples"]);
    expect(gateFailures({ key: "d", value: null, n: 0 })).toEqual([]);
    const cur = [{ key: "a", value: 0.9, n: 1 }, { key: "b", value: 0.08, max: 0.1, n: 1 }, { key: "c", value: 0.97, n: 1 }];
    expect(regressions(cur, { a: 0.95, b: 0.02, c: 0.99 })).toEqual(["a regressed: 0.950 → 0.900", "b regressed: 0.020 → 0.080"]);
  });
});

describe("deterministic suites (the CI gate)", () => {
  it("pass every gate on the seed datasets", async () => {
    const r = await runSuites({ suites: ["i1", "s2", "w1", "injection"] });
    expect(r.gateFailures).toEqual([]);
    expect(r.suites.map((s) => s.suite)).toEqual(["i1", "s2", "w1", "injection"]);
    for (const m of r.suites.flatMap((s) => s.metrics)) expect(m.n, m.key).toBeGreaterThan(0);
  });
});

describe("Q1 golden-set runner", () => {
  const examples = fileURLToPath(new URL("../datasets/golden/examples", import.meta.url));
  // Passes every requested criterion with a verbatim quote, unless the page says the company sells leads.
  const llm = () => new ScriptedLlm({
    "q1.judge": (req: LlmRequest<unknown>) => {
      const keys = /Evaluate these criteria: (.*)\./.exec(req.user)![1]!.split(", ");
      const seller = req.user.includes("We sell insurance leads to agents.");
      return { injection_suspected: false, results: keys.map((k) => seller && k === "not_competitor"
        ? { criterion_key: k, result: "fail", confidence: 0.9, rationale: "Sells leads.", quotes: [{ evidence_id: "e1", text: "We sell insurance leads to agents." }] }
        : seller ? { criterion_key: k, result: "unknown", confidence: 0.1, rationale: "n/a", quotes: [] }
        : { criterion_key: k, result: "pass", confidence: 0.9, rationale: "Stated.", quotes: [{ evidence_id: "e1", text: "We buy ACA leads from publishers through ping post." }] }) };
    },
    "q1.summary": () => ({ why_fit: ["Buys ACA leads"], risks: [] }),
  });

  it("is skipped without a model or a golden set", async () => {
    expect((await runQ1(null)).skipped).toMatch(/no model/);
    expect((await runQ1(llm(), { dir: "/nonexistent" })).skipped).toMatch(/no golden set/);
  });

  it("computes Tier A precision, Tier D recall and the unverified-quote rate", async () => {
    const r = await runQ1(llm(), { dir: examples });
    const m = Object.fromEntries(r.metrics.map((x) => [x.key, x]));
    expect(m["q1.tier_a_precision"]).toMatchObject({ value: 1, n: 2 });            // the two fit rows
    expect(m["q1.tier_d_recall_not_fit"]).toMatchObject({ value: 1, n: 2 });       // seller (knockout) and non-US (rule)
    expect(m["q1.unverified_quote_rate"]!.value).toBe(0);
    expect(r.failures).toEqual([]);
  });
});
