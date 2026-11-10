import { z } from "zod";
import { LlmOutputError, PLATFORM_RULES, untrusted, type LlmGateway, type LlmUsage } from "@abcrm/llm";

export type Messaging = { angles: string[]; avoid: string[]; cta_options: string[] };
export type WriterInput = {
  company: { name: string; domain: string };
  contact: { firstName: string | null; title: string | null };
  supply: { positioning: string | null; leadTypes: unknown; states: string[]; compliance: unknown } | null;
  /** Verified facts only (agents.md W1): criterion key → quotes that passed verification. */
  facts: { key: string; name: string; quotes: string[] }[];
  whyFit: string[];
  messaging: Messaging;
};
export type Draft = { subject: string; body: string; aiSpans: { start: number; end: number }[]; personalizationBasis: string[] };

/** CAN-SPAM footer (address, unsubscribe) is inserted at send time in Phase 2; the placeholder keeps it visible to reps. */
export const FOOTER_PLACEHOLDER = "{{footer}}";
const PROMISES = ["guaranteed", "guarantee", "cheapest", "unlimited", "100%", "risk-free", "no risk"];
const EMOJI = /\p{Extended_Pictographic}/u;
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|ai|biz|info)\b/gi;

export const W1_INSTRUCTIONS = `Task: write the first cold email from a lead-generation agency (our user) to a person at a company that buys data leads.
Rules:
- US English, plain text, at most 120 words in the body, a subject under 60 characters. No emoji, no links, no attachments, at most one exclamation mark.
- Mention only facts listed under "Verified facts". Never invent volumes, prices, results or names.
- Make one clear ask, chosen from the CTA options, ending with a question mark.
- Do not use any phrase from the avoid list and make no promises (guaranteed, cheapest, unlimited).
- Greet the contact by first name when given. Sign off with "{{sender_name}}".
- personalization_basis: the criterion keys of the verified facts you used (1–3).
- ai_spans: character ranges [start, end) of the body that you wrote from the facts (personalized sentences).`;

const Out = z.object({
  subject: z.string(),
  body: z.string(),
  ai_spans: z.array(z.object({ start: z.number(), end: z.number() })),
  personalization_basis: z.array(z.string()),
});

/** Code validator run after the LLM (agents.md W1 content rules). Returns violations; empty means the draft is acceptable. */
export function validateDraft(d: Draft, ctx: { avoid: string[]; factKeys: string[] }): string[] {
  const v: string[] = [];
  const text = `${d.subject}\n${d.body}`.toLowerCase();
  if (!d.subject.trim() || d.subject.length > 80) v.push("subject must be 1–80 characters");
  if (!d.body.trim() || d.body.length > 1200) v.push("body must be 1–1200 characters");
  if (d.body.split(/\s+/).filter(Boolean).length > 160) v.push("body is longer than 160 words");
  for (const p of [...ctx.avoid, ...PROMISES]) if (p && text.includes(p.toLowerCase())) v.push(`uses avoided phrase "${p}"`);
  if (EMOJI.test(d.subject) || EMOJI.test(d.body)) v.push("contains emoji");
  if ((d.body.match(/!/g) ?? []).length > 2) v.push("more than 2 exclamation marks");
  if ((`${d.subject} ${d.body}`.match(LINK) ?? []).length) v.push("contains a link or domain");
  if (!/\?\s*(\n|$)/m.test(d.body.replace(FOOTER_PLACEHOLDER, ""))) v.push("no clear question/CTA");
  if (!d.personalizationBasis.length) v.push("personalization_basis is empty");
  for (const k of d.personalizationBasis) if (!ctx.factKeys.includes(k)) v.push(`personalization_basis "${k}" is not a verified fact`);
  return v;
}

function promptFor(i: WriterInput, feedback: string[]): string {
  const facts = i.facts.map((f) => untrusted(`criterion:${f.key}`, null, `${f.name}\n${f.quotes.map((q) => `"${q}"`).join("\n")}`)).join("\n");
  return [
    `Company: ${i.company.name} (${i.company.domain}). Contact: ${i.contact.firstName ?? "(no first name)"}, ${i.contact.title ?? "unknown title"}.`,
    `Our agency: ${JSON.stringify(i.supply ?? { positioning: null })}`,
    `Why fit (from verified results): ${i.whyFit.join(" | ") || "n/a"}`,
    `Verified facts:\n${facts || "(none)"}`,
    `Angles: ${i.messaging.angles.join(" | ")}`,
    `Avoid: ${i.messaging.avoid.join(", ")}`,
    `CTA options: ${i.messaging.cta_options.join(" | ")}`,
    ...(feedback.length ? [`Your previous draft was rejected for: ${feedback.join("; ")}. Fix these.`] : []),
  ].join("\n\n");
}

/**
 * W1: one medium-tier call, code validation, one retry with the violations as feedback. Returns null when no
 * acceptable draft results; the card then goes out with G-Q only and the rep can write the email.
 */
export async function composeFirstEmail(llm: LlmGateway, i: WriterInput):
  Promise<{ draft: Draft | null; violations: string[]; usages: LlmUsage[] }> {
  const usages: LlmUsage[] = [];
  const factKeys = i.facts.map((f) => f.key);
  let feedback: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: z.infer<typeof Out>;
    try {
      const r = await llm.generate({ tier: "medium", purpose: "w1.compose", system: [PLATFORM_RULES, W1_INSTRUCTIONS], user: promptFor(i, feedback), schema: Out, maxTokens: 1500 });
      usages.push(r.usage);
      out = r.output;
    } catch (e) {
      if (e instanceof LlmOutputError) { if (e.usage) usages.push(e.usage); feedback = ["output was not valid JSON for the schema"]; continue; }
      throw e;
    }
    const body = `${out.body.trim()}\n\n${FOOTER_PLACEHOLDER}`;
    const draft: Draft = {
      subject: out.subject.trim(), body,
      aiSpans: out.ai_spans.filter((s) => s.start >= 0 && s.end > s.start && s.end <= out.body.trim().length).map((s) => ({ start: Math.floor(s.start), end: Math.floor(s.end) })),
      personalizationBasis: [...new Set(out.personalization_basis)].slice(0, 3),
    };
    const violations = validateDraft(draft, { avoid: i.messaging.avoid, factKeys });
    if (!violations.length) return { draft, violations: [], usages };
    feedback = violations;
  }
  return { draft: null, violations: feedback, usages };
}
