import { describe, expect, it } from "vitest";
import { ScriptedLlm } from "@abcrm/llm";
import { extractFindings, mergeFindings, type Findings, type S1Output } from "../src/index.js";

const page = { url: "https://b.com/publishers", pageId: "p1", text: "Publisher program. We purchase Medicare and ACA leads from approved vendors via ping post. Based in Austin, TX." };
const base: Findings = { domain: "b.com", name: "B", reachable: true, isLeadBuyerLikely: false, isCompetitorLikely: false, tech: {}, leadTypes: [],
  snippets: [], pagesFetched: 1, pages: [page] };
const out = (o: Partial<S1Output>): S1Output => ({ is_lead_buyer_likely: "unclear", is_competitor_likely: "no", buyer_type: "unknown", verticals: [], lead_types: [],
  purchase_signals: [], hq_country: null, hq_state: null, employee_range: null, injection_suspected: false, ...o });

describe("S1 extractor merge", () => {
  it("accepts a yes only with a verified purchase signal and fills facts", () => {
    const m = mergeFindings(base, out({
      is_lead_buyer_likely: "yes", buyer_type: "aggregator", lead_types: ["medicare", "auto", "bogus"], hq_state: "tx", employee_range: "51-200",
      purchase_signals: [
        { evidence_text: "We purchase Medicare and ACA leads from approved vendors via ping post.", url: page.url },
        { evidence_text: "We buy one million leads every day from anyone at all.", url: page.url },   // not on the page
      ],
    }), ["medicare", "auto"]);
    expect(m.isLeadBuyerLikely).toBe(true);
    expect(m.snippets.map((s) => s.text)).toEqual(["We purchase Medicare and ACA leads from approved vendors via ping post."]);
    expect(m.leadTypes).toEqual(["medicare", "auto"]);
    expect(m.facts).toEqual({ buyerType: "aggregator", hqCountry: "US", hqState: "TX", employeeRange: "51-200" });

    const unsupported = mergeFindings(base, out({ is_lead_buyer_likely: "yes", purchase_signals: [{ evidence_text: "We buy leads from everybody always, every day.", url: page.url }] }), []);
    expect(unsupported.isLeadBuyerLikely).toBe(false);
  });

  it("a no or a competitor verdict overrides positive rule signals", () => {
    const positive = { ...base, isLeadBuyerLikely: true };
    expect(mergeFindings(positive, out({ is_lead_buyer_likely: "no" }), []).isLeadBuyerLikely).toBe(false);
    expect(mergeFindings(positive, out({ is_competitor_likely: "yes" }), []).isCompetitorLikely).toBe(true);
    expect(mergeFindings(positive, null, [])).toBe(positive);
  });

  it("calls the small tier with page text as untrusted data and survives bad output", async () => {
    const llm = new ScriptedLlm({ "s1.extract": () => out({ is_lead_buyer_likely: "yes" }) });
    const r = await extractFindings(llm, base, { vertical: "insurance", leadTypeLabels: { medicare: "Medicare" } });
    expect(r.output?.is_lead_buyer_likely).toBe("yes");
    expect(llm.calls[0]).toMatchObject({ tier: "small" });
    expect(llm.calls[0]!.user).toContain('<untrusted_data source="https://b.com/publishers">');
    const bad = await extractFindings(new ScriptedLlm({ "s1.extract": () => ({ nope: 1 }) }), base, { vertical: "insurance", leadTypeLabels: {} });
    expect(bad.output).toBeNull();
    expect(bad.usage).not.toBeNull();
  });
});
