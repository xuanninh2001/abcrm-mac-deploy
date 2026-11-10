import { getDomain } from "tldts";

export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("invalid email");
  return e;
}

/** Registrable domain (eTLD+1), lowercase. Accepts URLs, hosts or emails. */
export function normalizeDomain(input: string): string {
  const raw = input.trim().toLowerCase();
  const host = raw.includes("@") ? raw.split("@").pop()! : raw;
  const domain = getDomain(host.includes("://") ? host : `http://${host}`, { allowPrivateDomains: false });
  if (!domain) throw new Error(`invalid domain: ${input}`);
  return domain;
}

/** Whitespace/quote/dash normalization used for evidence quote verification. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
