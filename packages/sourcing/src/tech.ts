/**
 * Rule-based tech detection (no LLM). Patterns match script URLs, inline scripts, form actions and iframes.
 * ⚠ Signatures must be verified against real buyer sites during the M3 spike; extend via this table only.
 */
export const TECH_SIGNATURES: Record<string, RegExp[]> = {
  trustedform: [/api\.trustedform\.com/i, /trustedform\.js/i, /xxTrustedFormCertUrl/i],
  jornaya: [/create\.lidstatic\.com/i, /leadid_token/i, /\bLeadiD\b/i],
  leadspedia: [/leadspedia/i],
  boberdoo: [/boberdoo/i],
  everflow: [/everflow/i],
  cake: [/getcake\.com/i, /\bcake\.(?:js|com)\b/i],
  ringba: [/ringba\.com/i],
  retreaver: [/retreaver/i],
  tune: [/hasoffers\.com/i, /\btune\.com\b/i],
  leadconduit: [/leadconduit/i, /activeprospect\.com/i],
  phonexa: [/phonexa/i],
};

export type TechSignals = Record<string, { match: string }>;

export function detectTech(scripts: string[], inline: string): TechSignals {
  const haystacks = [...scripts, inline];
  const found: TechSignals = {};
  for (const [key, patterns] of Object.entries(TECH_SIGNATURES)) {
    for (const re of patterns) {
      const hit = haystacks.map((h) => h.match(re)).find(Boolean);
      if (hit) { found[key] = { match: hit[0].slice(0, 120) }; break; }
    }
  }
  return found;
}
