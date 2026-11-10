export type Segment = { text: string; ai: boolean };

/** Splits an email body into AI-written and other segments (W1 ai_spans are [start, end) offsets into the body). */
export function aiSegments(body: string, spans: { start: number; end: number }[]): Segment[] {
  const valid = spans.filter((s) => s.start >= 0 && s.end > s.start && s.end <= body.length).sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let pos = 0;
  for (const s of valid) {
    const start = Math.max(s.start, pos);
    if (start >= s.end) continue;
    if (start > pos) out.push({ text: body.slice(pos, start), ai: false });
    out.push({ text: body.slice(start, s.end), ai: true });
    pos = s.end;
  }
  if (pos < body.length) out.push({ text: body.slice(pos), ai: false });
  return out;
}

export type CardAction = "approve" | "approve_no_email" | "reject" | "snooze" | "next" | "prev" | "edit" | "escape";

/** Keyboard map of the card view (decision-inbox.md §1.1). Keys are ignored while typing in a field. */
export function cardKey(e: { key: string; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; targetTag?: string }): CardAction | null {
  if (e.key === "Escape") return "escape";
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.targetTag && ["INPUT", "TEXTAREA", "SELECT"].includes(e.targetTag)) return null;
  switch (e.key.toLowerCase()) {
    case "a": return e.shiftKey ? "approve_no_email" : "approve";
    case "r": return "reject";
    case "s": return "snooze";
    case "j": return "next";
    case "k": return "prev";
    case "e": return "edit";
    default: return null;
  }
}

/** Next local 09:00 at least an hour away — the default snooze target. */
export function nextMorning(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (d.getTime() - now.getTime() < 3600_000) d.setDate(d.getDate() + 1);
  return d;
}

export const REJECT_REASONS: { code: string; label: string }[] = [
  { code: "wrong_vertical", label: "Wrong vertical" }, { code: "wrong_lead_type", label: "Wrong lead type" },
  { code: "competitor", label: "Competitor" }, { code: "too_small", label: "Too small" }, { code: "too_large", label: "Too large" },
  { code: "already_working_with", label: "Already working with them" }, { code: "recently_contacted", label: "Recently contacted" },
  { code: "bad_reputation", label: "Bad reputation" }, { code: "not_us", label: "Not US" }, { code: "wrong_contact", label: "Wrong contact" },
  { code: "bad_email_draft", label: "Bad email draft" }, { code: "other", label: "Other (note required)" },
];

/** Splits the stored scorecard summary ("Why fit:\n- …\nRisks:\n- …") into its two bullet lists. */
export function parseSummary(summary: string | null): { why: string[]; risks: string[] } {
  const why: string[] = [];
  const risks: string[] = [];
  let into = why;
  for (const line of (summary ?? "").split("\n")) {
    if (/^risks:/i.test(line.trim())) into = risks;
    else if (line.startsWith("- ")) into.push(line.slice(2));
  }
  return { why, risks };
}

export type WorkingHours = Record<string, [string, string]>;

/** `{"mon-fri": ["08:30","17:30"], "sat": [...]}` → `mon-fri 08:30-17:30; sat 09:00-12:00` (editable in one field). */
export function formatHours(h: WorkingHours | null | undefined): string {
  return Object.entries(h ?? {}).map(([k, [a, b]]) => `${k} ${a}-${b}`).join("; ");
}

/** Inverse of formatHours; returns an error message instead of throwing. The API validates again. */
export function parseHours(text: string): { hours: WorkingHours } | { error: string } {
  const hours: WorkingHours = {};
  for (const part of text.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z]{3}(?:-[a-z]{3})?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/i.exec(part);
    if (!m) return { error: `Cannot read "${part}". Use e.g. "mon-fri 08:30-17:30".` };
    const pad = (t: string) => t.padStart(5, "0");
    hours[m[1]!.toLowerCase()] = [pad(m[2]!), pad(m[3]!)];
  }
  return Object.keys(hours).length ? { hours } : { error: "Add at least one day range." };
}

/** Import mapping: `required` is a list of alternatives; true when at least one group is fully mapped. */
export function mappingComplete(required: string[][], mapped: string[]): boolean {
  const have = new Set(mapped);
  return required.length === 0 || required.some((g) => g.every((f) => have.has(f)));
}

/** "company_domain" → "Company domain". */
export const fieldLabel = (f: string) => (f.charAt(0).toUpperCase() + f.slice(1)).replace(/_/g, " ");
