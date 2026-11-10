import { describe, expect, it } from "vitest";
import { ScriptedLlm } from "@abcrm/llm";
import { composeFirstEmail, validateDraft, FOOTER_PLACEHOLDER, type WriterInput } from "../src/index.js";

const good = { subject: "ACA data leads with TrustedForm", body: "Hi Ann,\n\nSaw that you buy ACA leads from publishers via ping post. We supply ACA data leads with TrustedForm on every lead.\n\nOpen to a 50-lead test this month?\n\n{{sender_name}}",
  ai_spans: [{ start: 9, end: 60 }], personalization_basis: ["buys_leads"] };
const input: WriterInput = {
  company: { name: "Buyer", domain: "buyer.com" }, contact: { firstName: "Ann", title: "Affiliate Manager" },
  supply: { positioning: "ACA data leads", leadTypes: [], states: [], compliance: { trustedform: true } },
  facts: [{ key: "buys_leads", name: "Buys leads", quotes: ["We buy ACA leads from publishers via ping post."] }], whyFit: ["Buys ACA leads"],
  messaging: { angles: ["TrustedForm on every lead"], avoid: ["guaranteed", "cheapest"], cta_options: ["Open to a 50-lead test this month?"] },
};
const draft = (o: Partial<typeof good> = {}) => {
  const d = { ...good, ...o };
  return { subject: d.subject, body: d.body, aiSpans: d.ai_spans, personalizationBasis: d.personalization_basis };
};

describe("W1 validator", () => {
  const ctx = { avoid: input.messaging.avoid, factKeys: ["buys_leads"] };
  it("accepts a compliant draft", () => expect(validateDraft(draft(), ctx)).toEqual([]));
  it.each([
    [{ body: "Hi Ann, guaranteed results. Open to a test?" }, "guaranteed"],
    [{ body: "Hi Ann! Great! Really! Open to a test?" }, "exclamation"],
    [{ body: "Hi Ann 🚀 open to a test?" }, "emoji"],
    [{ body: "See https://agency.com/rates. Open to a test?" }, "link"],
    [{ body: "Visit agency.com for specs. Open to a test?" }, "link"],
    [{ body: "Hi Ann, we sell leads." }, "CTA"],
    [{ personalization_basis: ["made_up"] }, "not a verified fact"],
    [{ personalization_basis: [] }, "empty"],
    [{ subject: "x".repeat(90) }, "subject"],
  ])("rejects %j (%s)", (o, needle) => {
    expect(validateDraft(draft(o as never), ctx).join("; ")).toContain(needle);
  });
});

describe("composeFirstEmail", () => {
  it("retries once with the violations as feedback, then gives up", async () => {
    let n = 0;
    const llm = new ScriptedLlm({ "w1.compose": () => (n++ === 0 ? { ...good, body: "Cheapest leads, guaranteed. Open to a test?" } : good) });
    const r = await composeFirstEmail(llm, input);
    expect(r.draft?.body).toContain(FOOTER_PLACEHOLDER);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.user).toContain("previous draft was rejected");
    expect(r.usages).toHaveLength(2);

    const bad = new ScriptedLlm({ "w1.compose": () => ({ ...good, body: "Guaranteed!!! leads" }) });
    const r2 = await composeFirstEmail(bad, input);
    expect(r2.draft).toBeNull();
    expect(r2.violations.length).toBeGreaterThan(0);
    expect(bad.calls[0]!.user).toContain('<untrusted_data source="criterion:buys_leads">');
  });
});
