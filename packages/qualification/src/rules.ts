import jsonLogic from "json-logic-js";

/** Variables a playbook rule may reference (ipp-playbook-format.md §3.2). "" is the iteration item in some/none/all. */
export const RULE_VARIABLES = new Set([
  "", "account.hq_country", "account.hq_state", "account.employee_range", "account.buyer_type", "account.verticals",
  "account.lead_types", "account.flags", "account.tech_signal_keys", "account.founded_year", "contacts.count_valid",
]);

export function ruleVariables(rule: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(rule)) rule.forEach((r) => ruleVariables(r, out));
  else if (rule && typeof rule === "object") {
    for (const [op, arg] of Object.entries(rule)) {
      if (op === "var") {
        const name = Array.isArray(arg) ? arg[0] : arg;
        out.add(typeof name === "string" ? name : String(name));
      } else ruleVariables(arg, out);
    }
  }
  return out;
}

export function validateRule(rule: unknown): string[] {
  return [...ruleVariables(rule)].filter((v) => !RULE_VARIABLES.has(v)).map((v) => `variable not allowed: ${v}`);
}

export interface RuleFacts {
  account: {
    hq_country?: string | null; hq_state?: string | null; employee_range?: string | null; buyer_type?: string | null;
    verticals: string[]; lead_types: string[]; flags: string[]; tech_signals: Record<string, unknown>; founded_year?: number | null;
  };
  contacts: { email_status: string[] };
}

/** Evaluates a rule. Missing inputs referenced by the rule yield "unknown" instead of a guess. */
export function evaluateRule(rule: unknown, facts: RuleFacts): "pass" | "fail" | "unknown" {
  const errors = validateRule(rule);
  if (errors.length) throw new Error(errors.join("; "));
  const data = {
    account: { ...facts.account, tech_signal_keys: Object.keys(facts.account.tech_signals) },
    contacts: { count_valid: facts.contacts.email_status.filter((s) => s === "valid").length },
  };
  for (const v of ruleVariables(rule)) {
    if (v === "") continue;
    const value = v.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], data);
    if (value === undefined || value === null) return "unknown";
  }
  return jsonLogic.apply(rule as jsonLogic.RulesLogic, data) ? "pass" : "fail";
}
