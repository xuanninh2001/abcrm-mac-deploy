export type CardRow = {
  card_id: string; status: string; group_key: string | null; group_name: string | null; assignee_user_id: string | null; escalation_level: number;
  sla_due_at: string | null; expires_at: string | null; content_hash: string; account: { id: string; name: string; domain: string };
  tier: string; score: number; top_reason: string | null; contact: { title: string | null; email_status: string | null };
  first_line: string | null; has_draft: boolean; created_at: string;
};

export type Quote = { text: string; evidence_id: string; url: string | null; retrieved_at: string | null };
export type CriterionRow = {
  key: string; name: string; kind: string; evaluation: string; result: string; confidence: number | null; rationale: string | null; points: number;
  quotes: Quote[]; verified_by: { user_id: string; note: string; at: string }[];
};
export type CardContact = { id: string; first_name: string | null; last_name: string | null; email: string | null; title: string | null;
  linkedin_url: string | null; email_status: string | null; status: string; preselected: boolean };
export type CardDetail = {
  card_id: string; status: string; content_hash: string; snoozed_until: string | null; assignee_user_id: string | null; sla_due_at: string | null;
  escalation_level: number; decisions: { id: string; gate_id: string; status: string }[];
  account: { id: string; name: string; domain: string; buyer_type: string | null; verticals: string[]; lead_types: string[]; hq_state: string | null;
    hq_country: string | null; employee_range: string | null; tech_signals: Record<string, unknown>; status: string; flags: string[] };
  scorecard: { id: string; tier: string; total_score: number; stopped_at: string | null; summary: string | null; playbook_id: string; playbook_version: number;
    criteria: CriterionRow[] };
  contacts: CardContact[];
  email_draft: { id: string; contact_id: string; subject: string; body: string; ai_spans: { start: number; end: number }[]; status: string } | null;
  credits: { agent: number; contact: number };
};
export type User = { id: string; name: string | null; email: string; role: string };
export type TeamMember = User & { status: "invited" | "active" | "disabled"; timezone: string; invited_at: string | null; activated_at: string | null };
