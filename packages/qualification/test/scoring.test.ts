import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { evaluateRule, finalizeScorecard, validateRule, verifyQuotes, type CriterionDef, type CriterionOutcome } from "../src/index.js";

const T = { A: 75, B: 55, C: 35 };
const c = (key: string, kind: CriterionDef["kind"], weight = 0, extra: Partial<CriterionDef> = {}): CriterionDef =>
  ({ key, kind, evaluation: "ai_judged", weight, evidenceRequired: true, unknownPolicy: "neutral", unknownPenalty: 0, orderNo: 0, ...extra });
const pass = (key: string): CriterionOutcome => ({ key, result: "pass", quotes: [{ evidenceId: "e", text: "q", verified: true }] });
const out = (key: string, result: CriterionOutcome["result"]): CriterionOutcome => ({ key, result, quotes: [] });

// The Insurance "aca-fe-buyers" playbook shape (vertical-packs/insurance.yaml).
const playbook: CriterionDef[] = [
  c("us_operating", "knockout", 0, { evaluation: "rule", evidenceRequired: false, orderNo: 1 }),
  c("not_competitor", "knockout", 0, { orderNo: 2, evidenceRequired: false }),
  c("buys_matching_lead_types", "must_have", 0, { orderNo: 3 }),
  c("buys_data_leads_from_publishers", "must_have", 0, { orderNo: 4 }),
  c("uses_lead_distribution_tech", "scored", 10, { evaluation: "rule", evidenceRequired: false, orderNo: 5 }),
  c("accepts_offshore_publishers", "scored", 25, { orderNo: 6 }),
  c("hiring_affiliate_roles", "scored", 10, { orderNo: 7 }),
  c("requires_consent_certs", "scored", 15, { orderNo: 8 }),
  c("size_fit", "scored", 10, { evaluation: "rule", evidenceRequired: false, orderNo: 9 }),
  c("no_payment_red_flags", "scored", 20, { orderNo: 10 }),
];

describe("finalizeScorecard", () => {
  it("all pass → A with 100%", () => {
    const r = finalizeScorecard(playbook, playbook.map((x) => pass(x.key)), T);
    expect(r).toMatchObject({ tier: "A", pct: 100, points: 90, maxPoints: 90 });
  });

  it("knockout fail → D and stops", () => {
    const r = finalizeScorecard(playbook, [out("not_competitor", "fail"), ...playbook.slice(2).map((x) => pass(x.key))], T);
    expect(r).toMatchObject({ tier: "D", stoppedAt: "not_competitor" });
  });

  it("must-have unknown caps at C even with full points", () => {
    const outcomes = playbook.map((x) => (x.key === "buys_data_leads_from_publishers" ? out(x.key, "unknown") : pass(x.key)));
    const r = finalizeScorecard(playbook, outcomes, T);
    expect(r.tier).toBe("C");
    expect(r.caps).toContain("must_have_unknown:buys_data_leads_from_publishers");
  });

  it("pass without verified quote becomes unknown (evidence rule)", () => {
    const outcomes = playbook.map((x) => (x.key === "accepts_offshore_publishers"
      ? { key: x.key, result: "pass" as const, quotes: [{ evidenceId: "e", text: "made up", verified: false }] }
      : pass(x.key)));
    const r = finalizeScorecard(playbook, outcomes, T);
    expect(r.perCriterion.accepts_offshore_publishers).toEqual({ result: "unknown", points: 0 });
    expect(r.pct).toBe(Math.round((100 * 65) / 90));
  });

  it("penalize and block policies", () => {
    const crit = [c("a", "scored", 50, { unknownPolicy: "penalize", unknownPenalty: 10 }), c("b", "scored", 50, { unknownPolicy: "block" })];
    expect(finalizeScorecard(crit, [out("a", "unknown"), pass("b")], T)).toMatchObject({ points: 40, pct: 40, tier: "C" });
    expect(finalizeScorecard(crit, [pass("a"), out("b", "unknown")], T)).toMatchObject({ pct: 50, tier: "C" });
  });

  // INV-5: score depends only on (criteria, outcomes, thresholds), not on input order.
  it("is deterministic and order independent (INV-5)", () => {
    const result = fc.constantFrom("pass", "fail", "unknown", "skipped");
    fc.assert(fc.property(fc.array(result, { minLength: playbook.length, maxLength: playbook.length }), fc.boolean(), (rs, verified) => {
      const outcomes: CriterionOutcome[] = playbook.map((x, i) => ({ key: x.key, result: rs[i]!, quotes: [{ evidenceId: "e", text: "q", verified }] }));
      const a = finalizeScorecard(playbook, outcomes, T);
      const b = finalizeScorecard([...playbook].reverse(), [...outcomes].reverse(), T);
      expect(b).toEqual(a);
      expect(a.pct).toBeGreaterThanOrEqual(0);
      expect(a.pct).toBeLessThanOrEqual(100);
      if (outcomes.some((o, i) => playbook[i]!.kind === "knockout" && o.result === "fail")) expect(a.tier).toBe("D");
    }));
  });
});

describe("verifyQuotes (INV-4)", () => {
  const evidence = [{ id: "e1", snippet: "Become a lead vendor: we buy Medicare and ACA leads from publishers via ping-post." }];

  it("accepts verbatim quotes modulo whitespace/case/typography", () => {
    expect(verifyQuotes([{ evidenceId: "e1", text: "we buy  MEDICARE and ACA leads" }], evidence)[0]!.verified).toBe(true);
  });

  it("rejects paraphrases, wrong evidence ids and too-short quotes", () => {
    const [p, w, s] = verifyQuotes([
      { evidenceId: "e1", text: "we purchase Medicare leads" },
      { evidenceId: "e2", text: "we buy Medicare and ACA leads" },
      { evidenceId: "e1", text: "we buy" },
    ], evidence);
    expect([p!.verified, w!.verified, s!.verified]).toEqual([false, false, false]);
  });

  it("never verifies text that is not a substring", () => {
    fc.assert(fc.property(fc.string({ minLength: 8 }), (text) => {
      const [q] = verifyQuotes([{ evidenceId: "e1", text: `zz${text}zz-not-in-evidence` }], evidence);
      expect(q!.verified).toBe(false);
    }));
  });
});

describe("rules", () => {
  const facts = {
    account: { hq_country: "US", employee_range: "51-200", verticals: ["insurance"], lead_types: [], flags: [], tech_signals: { trustedform: {} } },
    contacts: { email_status: ["valid", "catch_all"] },
  };

  it("evaluates the Insurance pack rule criteria", () => {
    expect(evaluateRule({ "==": [{ var: "account.hq_country" }, "US"] }, facts)).toBe("pass");
    expect(evaluateRule({ none: [{ var: "account.flags" }, { in: [{ var: "" }, ["competitor", "existing_buyer", "do_not_contact"]] }] }, facts)).toBe("pass");
    expect(evaluateRule({ some: [{ var: "account.tech_signal_keys" }, { in: [{ var: "" }, ["trustedform", "jornaya"]] }] }, facts)).toBe("pass");
    expect(evaluateRule({ in: [{ var: "account.employee_range" }, ["1-10"]] }, facts)).toBe("fail");
    expect(evaluateRule({ ">=": [{ var: "contacts.count_valid" }, 1] }, facts)).toBe("pass");
  });

  it("returns unknown when a referenced fact is missing", () => {
    expect(evaluateRule({ "==": [{ var: "account.hq_state" }, "FL"] }, facts)).toBe("unknown");
  });

  it("rejects variables outside the allowlist", () => {
    expect(validateRule({ "==": [{ var: "contacts.email" }, "x"] })).toEqual(["variable not allowed: contacts.email"]);
    expect(() => evaluateRule({ var: "account.custom.secret" }, facts)).toThrow(/not allowed/);
  });
});
