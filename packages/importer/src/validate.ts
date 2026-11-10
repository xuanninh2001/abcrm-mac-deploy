import { normalizeDomain, normalizeEmail } from "@abcrm/crypto";
import type { FieldMapEntry, Purpose, TargetField } from "./mapping.js";

export type RowStatus = "valid" | "warning" | "error" | "skipped";
export type Normalized = Partial<Record<TargetField, string>> & { verticals_list?: string[] };
export type RowResult = { status: RowStatus; normalized: Normalized; errors: string[]; warnings: string[]; key: string | null };

/** Personal mailbox domains: never treated as a company domain. */
export const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "yandex.com",
]);

const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));

export function applyMapping(raw: Record<string, string>, fieldMap: FieldMapEntry[]): Normalized {
  const out: Normalized = {};
  for (const { source, target } of fieldMap) {
    const v = raw[source]?.trim();
    if (v) out[target] = v;
  }
  return out;
}

/** Validates and normalizes one mapped row; `key` is the dedupe key within the file. */
export function validateRow(purpose: Purpose, n: Normalized): RowResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: Normalized = { ...n };

  if (out.email) {
    try { out.email = normalizeEmail(out.email); } catch { errors.push("invalid email"); delete out.email; }
  }
  if (out.company_domain) {
    try { out.company_domain = normalizeDomain(out.company_domain); } catch { errors.push("invalid company domain"); delete out.company_domain; }
  }
  if (!out.company_domain && out.email && purpose !== "blocklist") {
    const d = normalizeDomain(out.email);
    if (PERSONAL_EMAIL_DOMAINS.has(d)) errors.push("personal email and no company domain");
    else { out.company_domain = d; warnings.push("company domain derived from email"); }
  }
  if (out.company_domain && PERSONAL_EMAIL_DOMAINS.has(out.company_domain) && purpose !== "blocklist") {
    errors.push(`${out.company_domain} is a personal mailbox domain, not a company`);
  }
  if (out.full_name && !out.first_name && !out.last_name) {
    const parts = out.full_name.split(/\s+/);
    out.first_name = parts[0];
    if (parts.length > 1) out.last_name = parts.slice(1).join(" ");
  }
  if (out.hq_state) {
    const s = out.hq_state.toUpperCase();
    if (US_STATES.has(s)) out.hq_state = s; else { warnings.push(`unrecognized state "${out.hq_state}" dropped`); delete out.hq_state; }
  }
  if (out.verticals) out.verticals_list = out.verticals.split(/[,;|]/).map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (out.linkedin_url && !/^https?:\/\/([a-z]+\.)?linkedin\.com\//i.test(out.linkedin_url)) { warnings.push("linkedin_url ignored (not a LinkedIn URL)"); delete out.linkedin_url; }

  let key: string | null = null;
  switch (purpose) {
    case "accounts": case "existing_buyers":
      if (!out.company_domain) errors.push("company domain is required");
      key = out.company_domain ?? null;
      break;
    case "contacts":
      if (!out.company_domain && !errors.some((e) => e.includes("domain"))) errors.push("company domain is required (or a company email)");
      if (!out.email && !out.first_name) errors.push("email or name is required");
      key = out.email ?? (out.company_domain && out.first_name ? `${out.company_domain}|${out.first_name}|${out.last_name ?? ""}`.toLowerCase() : null);
      break;
    case "blocklist": {
      const v = out.value ?? out.email ?? out.company_domain;
      if (!v) { errors.push("email or domain is required"); break; }
      try { out.value = v.includes("@") ? normalizeEmail(v) : normalizeDomain(v); key = out.value; }
      catch { errors.push("invalid email or domain"); }
      break;
    }
  }
  return { status: errors.length ? "error" : warnings.length ? "warning" : "valid", normalized: out, errors, warnings, key };
}
