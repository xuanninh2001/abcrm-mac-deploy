import { normalizeText } from "@abcrm/crypto";
import type { Evidence, Quote, VerifiedQuote } from "./types.js";

export const MIN_QUOTE_CHARS = 8;

/** A quote is verified only if its normalized text occurs verbatim in the cited evidence (ADR-013). */
export function verifyQuotes(quotes: Quote[], evidence: Evidence[]): VerifiedQuote[] {
  const byId = new Map(evidence.map((e) => [e.id, normalizeText(e.snippet)]));
  return quotes.map((q) => {
    const haystack = byId.get(q.evidenceId);
    const needle = normalizeText(q.text);
    return { ...q, verified: haystack !== undefined && needle.length >= MIN_QUOTE_CHARS && haystack.includes(needle) };
  });
}

/** Applies the evidence rule: a "pass" without any verified quote becomes "unknown" when evidence is required. */
export function enforceEvidence(result: "pass" | "fail" | "unknown", evidenceRequired: boolean, quotes: VerifiedQuote[]) {
  if (result === "pass" && evidenceRequired && !quotes.some((q) => q.verified)) return "unknown" as const;
  return result;
}
