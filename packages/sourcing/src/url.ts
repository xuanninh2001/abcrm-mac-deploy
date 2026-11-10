import { isIP } from "node:net";
import { normalizeDomain } from "@abcrm/crypto";

/** Canonical form for caching: lowercase host, no fragment, no default port, no trailing-slash-only path differences. */
export function normalizeUrl(input: string): URL {
  const u = new URL(input);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are fetched");
  if (u.username || u.password) throw new Error("credentials in URL are not allowed");
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  return u;
}

/** eTLD+1 for names; IP hosts are their own "site". */
export function registrableDomain(u: URL | string): string {
  const host = (typeof u === "string" ? u : u.hostname).replace(/^\[|\]$/g, "");
  return isIP(host) ? host : normalizeDomain(host);
}

/** `*.example.com` matches subdomains and the apex; `example.com` matches the apex and subdomains too (policy is per site). */
export function matchesDomainPattern(host: string, pattern: string): boolean {
  const p = pattern.replace(/^\*\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === p || h.endsWith(`.${p}`);
}
