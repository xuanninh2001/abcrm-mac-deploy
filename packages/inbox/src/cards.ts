import { createHash } from "node:crypto";
import { withTenant, type Actor, type Pool, type TenantTx } from "@abcrm/db";
import { emit, notFound, Problem, recordUsage, releaseReservation, reserveCredits, uuidv7, type TenantKeyring } from "@abcrm/core";
import { approveDecision, contentHash, ensureAgent, evaluateQualityBreaker, executeApproved, killSwitchOn, proposeDecision, rejectDecision, type Principal } from "@abcrm/agents";
import { recordLlmCost, type LlmGateway } from "@abcrm/llm";
import { composeFirstEmail, type Draft, type Messaging } from "./writer.js";
import { assignCard } from "./routing.js";

export type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
export type CardDeps = { pool: Pool; keyring: TenantKeyring; llm: LlmGateway | null; messagingFor?: (vertical: string) => Promise<Messaging | null>; step?: Step };

export const CARD_CREDITS = 2;
export const CARD_TTL_DAYS = 14;
export const REJECT_REASONS = ["wrong_vertical", "wrong_lead_type", "competitor", "too_small", "too_large", "already_working_with",
  "recently_contacted", "bad_reputation", "not_us", "wrong_contact", "bad_email_draft", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

type CardContact = { contactId: string; preselected: boolean };
type GqArgs = { accountId: string; scorecardId: string; candidateId: string; contacts: CardContact[] };
type GoutArgs = { draftId: string; contactId: string; subject: string; body: string; aiSpans: { start: number; end: number }[] };
type DecisionRow = { id: string; gate_id: "G-Q" | "G-OUT"; status: string; content_hash: Buffer; action: { tool: string; args: Record<string, unknown> };
  subject_id: string; proposed_by: { agentRunId?: string }; snoozed_until: Date | null; assignee_user_id: string | null; sla_due_at: Date | null; escalation_level: number };

const system: Actor = { type: "system", id: "card-writer" };
const DEFAULT_MESSAGING: Messaging = { angles: [], avoid: [], cta_options: ["Open to a small test this month?"] };

/** Card hash = sha256 of the G-Q hash and the G-OUT hash: what the rep reviewed, in one value (bulk approve). */
export const cardHash = (gq: Buffer, gout: Buffer | null) => createHash("sha256").update(gq).update(gout ?? Buffer.alloc(0)).digest("hex");

/** SLA for lane `contact`: one business day (decision-inbox.md §3), weekends skipped. Working-hour precision comes with notifications. */
export function contactSla(now = new Date()): Date {
  const d = new Date(now.getTime() + 24 * 3600_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * Q1 step 5 (agents.md): for a card-eligible scorecard with ≥ 1 contact, W1 writes the first email and a card
 * is proposed as two decisions sharing a card_id — G-Q (approve account + contacts) and G-OUT (approve email).
 * Charged at creation (D12). One pending card per account.
 */
export async function proposeCard(deps: CardDeps, tenantId: string, candidateId: string): Promise<{ status: "proposed"; cardId: string } | { status: "skipped"; reason: string }> {
  const step: Step = deps.step ?? ((_n, fn) => fn());
  const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(deps.pool, tenantId, system, fn);

  const ctx = await step("card:load", () => inTenant(async (tx) => {
    const { rows: [c] } = await tx.client.query<{ status: string; account_id: string; scorecard_id: string | null; sourcing_run_id: string | null; decision_id: string | null }>(
      "SELECT status, account_id, scorecard_id, sourcing_run_id, decision_id FROM abcrm.candidates WHERE id = $1", [candidateId]);
    if (!c || !c.scorecard_id) return { skip: "no_scorecard" };
    if (c.status === "carded" && c.decision_id) {
      const { rows: [d] } = await tx.client.query<{ card_id: string }>("SELECT card_id FROM abcrm.decisions WHERE id = $1", [c.decision_id]);
      return { done: d!.card_id };
    }
    if (c.status !== "scored") return { skip: `candidate_${c.status}` };
    if (await killSwitchOn(tx)) return { skip: "kill_switch" };
    const agent = await ensureAgent(tx, "W1");
    if (agent.status !== "active") return { skip: "agent_paused" };
    const { rows: [sc] } = await tx.client.query<{ tier: string; total_score: number; summary: string | null; playbook_id: string; card_min_tier: string }>(
      `SELECT s.tier, s.total_score, s.summary, s.playbook_id, p.card_min_tier FROM abcrm.scorecards s JOIN abcrm.playbooks p ON p.id = s.playbook_id WHERE s.id = $1`, [c.scorecard_id]);
    if ("ABCD".indexOf(sc!.tier) > "ABCD".indexOf(sc!.card_min_tier)) return { skip: "below_card_min_tier" };
    const { rows: [acc] } = await tx.client.query<{ name: string; domain: string; status: string; flags: string[]; verticals: string[] }>(
      "SELECT name, domain, status, flags, verticals FROM abcrm.accounts WHERE id = $1", [c.account_id]);
    if (acc!.flags.some((f) => ["competitor", "existing_buyer", "do_not_contact"].includes(f)) || acc!.status === "blocked") return { skip: "account_flagged" };
    const pending = await tx.client.query("SELECT 1 FROM abcrm.decisions WHERE gate_id = 'G-Q' AND subject_id = $1 AND status = 'pending'", [c.account_id]);
    if (pending.rowCount) return { skip: "card_already_pending" };
    if (!(await reserveCredits(tx, "agent", CARD_CREDITS, `cardres:${candidateId}`))) return { skip: "quota_exhausted" };

    // Contacts: S2 results first (title match, preselection), then other active contacts with a deliverable email.
    const { rows: lk } = await tx.client.query<{ results: { contactId: string; preselected: boolean }[] }>(
      "SELECT results FROM abcrm.contact_lookups WHERE candidate_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 1", [candidateId]);
    const { rows: active } = await tx.client.query<{ id: string; first_name_enc: Buffer | null; title: string | null; v: string | null }>(
      `SELECT id, first_name_enc, title, email_verification->>'result' AS v FROM abcrm.contacts
       WHERE account_id = $1 AND status = 'active' AND email_bidx IS NOT NULL ORDER BY created_at`, [c.account_id]);
    const usable = new Map(active.filter((a) => a.v === null || a.v === "valid" || a.v === "catch_all").map((a) => [a.id, a]));
    const contacts: CardContact[] = (lk[0]?.results ?? []).filter((r) => usable.has(r.contactId)).map((r) => ({ contactId: r.contactId, preselected: r.preselected }));
    for (const a of usable.values()) if (contacts.length < 5 && !contacts.some((x) => x.contactId === a.id)) contacts.push({ contactId: a.id, preselected: false });
    if (!contacts.length) {
      await releaseReservation(tx, `cardres:${candidateId}`);
      await tx.client.query("UPDATE abcrm.candidates SET status = 'scored' WHERE id = $1", [candidateId]);
      return { skip: "no_contact" };
    }
    if (!contacts.some((x) => x.preselected)) contacts[0]!.preselected = true;
    const first = usable.get(contacts.find((x) => x.preselected)!.contactId)!;

    // Verified facts only: quotes stored on criterion results passed substring verification in Q1.
    const { rows: facts } = await tx.client.query<{ key: string; name: string; quotes: { text: string }[] }>(
      `SELECT c.key, c.name, r.quotes FROM abcrm.criterion_results r JOIN abcrm.criteria c ON c.id = r.criterion_id
       WHERE r.scorecard_id = $1 AND r.result = 'pass' AND jsonb_array_length(r.quotes) > 0 ORDER BY c.order_no`, [c.scorecard_id]);
    const { rows: [sp] } = await tx.client.query<{ positioning: string | null; lead_types: unknown; states: string[]; compliance_assets: unknown }>(
      "SELECT positioning, lead_types, states, compliance_assets FROM abcrm.supply_profiles WHERE status = 'active'");
    const ipp = c.sourcing_run_id
      ? (await tx.client.query<{ id: string; vertical: string }>("SELECT i.id, i.vertical FROM abcrm.sourcing_runs r JOIN abcrm.ipps i ON i.id = r.ipp_id WHERE r.id = $1", [c.sourcing_run_id])).rows[0]
      : undefined;
    return {
      candidate: c, scorecard: sc!, account: acc!, contacts, agentId: agent.definitionId, groupKey: ipp?.id ?? "manual", vertical: ipp?.vertical ?? acc!.verticals[0] ?? null,
      writer: {
        company: { name: acc!.name, domain: acc!.domain },
        contact: { firstName: first.first_name_enc ? await deps.keyring.decrypt(tx, "contacts.first_name", first.first_name_enc) : null, title: first.title },
        supply: sp ? { positioning: sp.positioning, leadTypes: sp.lead_types, states: sp.states, compliance: sp.compliance_assets } : null,
        facts: facts.map((f) => ({ key: f.key, name: f.name, quotes: f.quotes.map((q) => q.text).slice(0, 3) })),
        whyFit: (sc!.summary ?? "").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).slice(0, 3),
      },
      preselectedContact: first.id,
    };
  }));
  if ("skip" in ctx) return { status: "skipped", reason: String(ctx.skip) };
  if ("done" in ctx) return { status: "proposed", cardId: String(ctx.done) };

  const messaging = (ctx.vertical && deps.messagingFor ? await deps.messagingFor(ctx.vertical) : null) ?? DEFAULT_MESSAGING;
  const written = deps.llm
    ? await step("card:compose", () => composeFirstEmail(deps.llm!, { ...ctx.writer, messaging }))
    : { draft: null as Draft | null, violations: ["llm_unavailable"], usages: [] };

  return step("card:persist", () => inTenant(async (tx) => {
    const cardId = uuidv7();
    const slaDueAt = contactSla();
    const expiresAt = new Date(Date.now() + CARD_TTL_DAYS * 86_400_000);
    // W1 runs inside the Q1 workflow: proposals are attributed to the Q1 run that produced the scorecard.
    const agentRunId = (await q1RunId(tx, ctx.candidate.scorecard_id!)) ?? cardId;
    const evidence = { tier: ctx.scorecard.tier, score: ctx.scorecard.total_score, scorecard_id: ctx.candidate.scorecard_id,
      draft_violations: written.draft ? [] : written.violations };
    const gqArgs: GqArgs = { accountId: ctx.candidate.account_id, scorecardId: ctx.candidate.scorecard_id!, candidateId, contacts: ctx.contacts };
    const gq = await proposeDecision(tx, {
      gate: "G-Q", lane: "contact", cardId, subject: { type: "account", id: ctx.candidate.account_id },
      action: { tool: "account.approve_contact", args: gqArgs }, proposedBy: { type: "agent", agentRunId },
      explanation: `Tier ${ctx.scorecard.tier} (${ctx.scorecard.total_score}%) buyer: approve to contact`, evidence,
      assigneeRole: "sales_rep", slaDueAt, expiresAt, groupKey: ctx.groupKey,
    });
    let draftId: string | null = null;
    if (written.draft) {
      draftId = uuidv7();
      const goutArgs: GoutArgs = { draftId, contactId: ctx.preselectedContact, subject: written.draft.subject, body: written.draft.body, aiSpans: written.draft.aiSpans };
      const gout = await proposeDecision(tx, {
        gate: "G-OUT", lane: "contact", cardId, subject: { type: "email_draft", id: draftId },
        action: { tool: "email_draft.approve", args: goutArgs }, proposedBy: { type: "agent", agentRunId },
        explanation: "First email (sent in Phase 2)", evidence: { personalization_basis: written.draft.personalizationBasis },
        assigneeRole: "sales_rep", slaDueAt, expiresAt, groupKey: ctx.groupKey,
      });
      await tx.client.query(
        `INSERT INTO abcrm.email_drafts(id, tenant_id, account_id, contact_id, decision_id, subject, body, ai_spans, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [draftId, tenantId, ctx.candidate.account_id, ctx.preselectedContact, gout, written.draft.subject, written.draft.body,
          JSON.stringify(written.draft.aiSpans), contentHash(goutArgs)]);
    }
    await tx.client.query("UPDATE abcrm.accounts SET status = 'carded' WHERE id = $1 AND status = 'prospect'", [ctx.candidate.account_id]);
    await tx.client.query("UPDATE abcrm.candidates SET status = 'carded', decision_id = $2 WHERE id = $1", [candidateId, gq]);
    const meterKey = `card:${candidateId}`;
    await releaseReservation(tx, `cardres:${candidateId}`);
    await recordUsage(tx, { idempotencyKey: meterKey, meter: "agent", actionType: "card", credits: CARD_CREDITS, agentDefinitionId: ctx.agentId,
      decisionId: gq, sourcingRunId: ctx.candidate.sourcing_run_id });
    for (const u of written.usages) await recordLlmCost(tx, u, { meterLink: meterKey });
    if (ctx.candidate.sourcing_run_id) {
      await tx.client.query(
        `UPDATE abcrm.sourcing_runs SET stats = stats || jsonb_build_object('carded', coalesce((stats->>'carded')::int, 0) + 1,
           'agent_credits_used', coalesce((stats->>'agent_credits_used')::numeric, 0) + $2) WHERE id = $1`, [ctx.candidate.sourcing_run_id, CARD_CREDITS]);
    }
    // Round-robin to a rep; the SLA becomes one working day in the assignee's hours (contactSla is the fallback without reps).
    await assignCard(tx, cardId);
    await emit(tx, "qualification.card.proposed", { card_id: cardId, decision_ids: [gq], account_id: ctx.candidate.account_id, has_draft: !!draftId });
    return { status: "proposed" as const, cardId };
  }));
}

async function q1RunId(tx: TenantTx, scorecardId: string): Promise<string | null> {
  const { rows: [r] } = await tx.client.query<{ agent_run_id: string | null }>("SELECT agent_run_id FROM abcrm.scorecards WHERE id = $1", [scorecardId]);
  return r?.agent_run_id ?? null;
}

async function loadCard(tx: TenantTx, cardId: string, lock = false) {
  const { rows } = await tx.client.query<DecisionRow>(
    `SELECT id, gate_id, status, content_hash, action, subject_id, proposed_by, snoozed_until, assignee_user_id, sla_due_at, escalation_level FROM abcrm.decisions
     WHERE card_id = $1 AND gate_id IN ('G-Q', 'G-OUT') ORDER BY gate_id ${lock ? "FOR UPDATE" : ""}`, [cardId]);
  const gq = rows.find((r) => r.gate_id === "G-Q");
  if (!gq) throw notFound("Card");
  return { gq, gout: rows.find((r) => r.gate_id === "G-OUT") ?? null };
}

/** GET /cards: pending cards (not snoozed), newest SLA first, with the fields of the table view (decision-inbox.md §1.2). */
export type CardViewer = { id: string; role: string };

/** Sales reps see their own cards and unassigned ones (decision-inbox.md §5); others see all. `mine` narrows to the viewer. */
export async function listCards(tx: TenantTx, opts: { status?: string; groupKey?: string; includeSnoozed?: boolean; limit: number; viewer?: CardViewer; mine?: boolean }) {
  const { rows } = await tx.client.query<{ card_id: string; gq_id: string; status: string; group_key: string | null; sla_due_at: Date | null; expires_at: Date | null;
    gq_hash: Buffer; gout_hash: Buffer | null; account_id: string; name: string; domain: string; tier: string; total_score: number; summary: string | null;
    contact_title: string | null; contact_status: string | null; draft_subject: string | null; draft_body: string | null; ipp_name: string | null; created_at: Date;
    assignee_user_id: string | null; escalation_level: number }>(
    `SELECT gq.card_id, gq.id AS gq_id, gq.status, gq.group_key, gq.sla_due_at, gq.expires_at, gq.content_hash AS gq_hash, gout.content_hash AS gout_hash,
            a.id AS account_id, a.name, a.domain, s.tier, s.total_score, s.summary, ct.title AS contact_title, ct.email_verification->>'result' AS contact_status,
            ed.subject AS draft_subject, ed.body AS draft_body, i.name AS ipp_name, gq.created_at, gq.assignee_user_id, gq.escalation_level
     FROM abcrm.decisions gq
     JOIN abcrm.accounts a ON a.id = gq.subject_id
     JOIN abcrm.scorecards s ON s.id = (gq.action->'args'->>'scorecardId')::uuid
     LEFT JOIN abcrm.decisions gout ON gout.card_id = gq.card_id AND gout.gate_id = 'G-OUT'
     LEFT JOIN abcrm.email_drafts ed ON ed.decision_id = gout.id
     LEFT JOIN abcrm.contacts ct ON ct.id = (SELECT (x->>'contactId')::uuid FROM jsonb_array_elements(gq.action->'args'->'contacts') x WHERE (x->>'preselected')::boolean LIMIT 1)
     LEFT JOIN abcrm.ipps i ON i.id::text = gq.group_key
     WHERE gq.gate_id = 'G-Q' AND gq.status = coalesce($1, 'pending') AND ($2::text IS NULL OR gq.group_key = $2)
       AND ($4 OR coalesce($1, 'pending') <> 'pending' OR gq.snoozed_until IS NULL OR gq.snoozed_until <= now())
       AND ($5::uuid IS NULL OR gq.assignee_user_id = $5 OR ($6 AND gq.assignee_user_id IS NULL))
     ORDER BY gq.sla_due_at NULLS LAST, gq.created_at LIMIT $3`,
    [opts.status ?? null, opts.groupKey ?? null, opts.limit, opts.includeSnoozed ?? false,
      opts.mine || opts.viewer?.role === "sales_rep" ? opts.viewer?.id ?? null : null, !opts.mine]);
  return rows.map((r) => ({
    card_id: r.card_id, status: r.status, group_key: r.group_key, group_name: r.ipp_name ?? (r.group_key === "manual" ? "Manual" : null),
    assignee_user_id: r.assignee_user_id, escalation_level: r.escalation_level,
    sla_due_at: r.sla_due_at, expires_at: r.expires_at, content_hash: cardHash(r.gq_hash, r.gout_hash),
    account: { id: r.account_id, name: r.name, domain: r.domain }, tier: r.tier, score: r.total_score,
    top_reason: (r.summary ?? "").split("\n").find((l) => l.startsWith("- "))?.slice(2) ?? null,
    contact: { title: r.contact_title, email_status: r.contact_status },
    first_line: r.draft_body ? r.draft_body.split("\n").find((l) => l.trim() && !/^(hi|hello|dear)\b/i.test(l.trim())) ?? null : null,
    has_draft: r.draft_subject !== null, created_at: r.created_at,
  }));
}

/** GET /cards/{id}: everything the rep needs to decide (decision-inbox.md §1.1). PII is decrypted for users with crm.read. */
export async function getCard(tx: TenantTx, keyring: TenantKeyring, cardId: string) {
  const { gq, gout } = await loadCard(tx, cardId);
  const args = gq.action.args as GqArgs;
  const { rows: [account] } = await tx.client.query(
    "SELECT id, name, domain, buyer_type, verticals, lead_types, hq_state, hq_country, employee_range, tech_signals, status, flags FROM abcrm.accounts WHERE id = $1", [args.accountId]);
  const { rows: [scorecard] } = await tx.client.query(
    "SELECT id, tier, total_score, stopped_at, summary, playbook_id, playbook_version, agent_credits, created_at FROM abcrm.scorecards WHERE id = $1", [args.scorecardId]);
  const { rows: criteria } = await tx.client.query(
    `SELECT c.key, c.name, c.kind, c.evaluation, r.result, r.confidence, r.rationale, r.points,
            (SELECT coalesce(jsonb_agg(jsonb_build_object('text', q->>'text', 'evidence_id', q->>'evidence_id', 'url', e.url, 'retrieved_at', e.retrieved_at)), '[]')
             FROM jsonb_array_elements(r.quotes) q LEFT JOIN abcrm.evidence e ON e.id = (q->>'evidence_id')::uuid) AS quotes,
            (SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', v.user_id, 'note', v.note, 'at', v.created_at) ORDER BY v.created_at), '[]')
             FROM abcrm.criterion_verifications v WHERE v.scorecard_id = r.scorecard_id AND v.criterion_id = r.criterion_id) AS verified_by
     FROM abcrm.criterion_results r JOIN abcrm.criteria c ON c.id = r.criterion_id WHERE r.scorecard_id = $1 ORDER BY c.order_no`, [args.scorecardId]);
  const contacts = [];
  for (const cc of args.contacts) {
    const { rows: [c] } = await tx.client.query<{ id: string; first_name_enc: Buffer | null; last_name_enc: Buffer | null; email_enc: Buffer | null; title: string | null;
      linkedin_url: string | null; status: string; v: string | null; title_normalized: string | null }>(
      `SELECT id, first_name_enc, last_name_enc, email_enc, title, linkedin_url, status, email_verification->>'result' AS v, title_normalized FROM abcrm.contacts WHERE id = $1`, [cc.contactId]);
    if (!c) continue;
    const dec = (b: Buffer | null, col: string) => (b ? keyring.decrypt(tx, col, b) : Promise.resolve(null));
    contacts.push({ id: c.id, first_name: await dec(c.first_name_enc, "contacts.first_name"), last_name: await dec(c.last_name_enc, "contacts.last_name"),
      email: await dec(c.email_enc, "contacts.email"), title: c.title, linkedin_url: c.linkedin_url, email_status: c.v, status: c.status, preselected: cc.preselected });
  }
  const draft = gout ? (await tx.client.query(
    "SELECT id, contact_id, subject, body, ai_spans, status FROM abcrm.email_drafts WHERE decision_id = $1", [gout.id])).rows[0] ?? null : null;
  const { rows: [credits] } = await tx.client.query<{ agent: number }>(
    `SELECT coalesce(sum(credits), 0)::float AS agent FROM abcrm.usage_events
     WHERE idempotency_key IN ($1, $2) OR idempotency_key LIKE 'srun:%:cand:' || $3`,
    [`card:${args.candidateId}`, `q1:${args.candidateId}:${(scorecard as { playbook_id: string }).playbook_id}`, args.accountId]);
  const { rows: [contactCredits] } = await tx.client.query<{ c: number }>(
    "SELECT coalesce(sum(contact_credits), 0)::float AS c FROM abcrm.contact_lookups WHERE candidate_id = $1", [args.candidateId]);
  return {
    card_id: cardId, status: gq.status, content_hash: cardHash(gq.content_hash, gout?.content_hash ?? null), snoozed_until: gq.snoozed_until,
    assignee_user_id: gq.assignee_user_id, sla_due_at: gq.sla_due_at, escalation_level: gq.escalation_level,
    decisions: [gq, ...(gout ? [gout] : [])].map((d) => ({ id: d.id, gate_id: d.gate_id, status: d.status })),
    account, scorecard: { ...scorecard, criteria }, contacts, email_draft: draft,
    credits: { agent: credits!.agent, contact: contactCredits!.c },
  };
}

export type ApproveInput = { contentHash: string; contactIds?: string[]; sendFirstEmail?: boolean; draft?: { subject: string; body: string } };

/**
 * POST /cards/{id}/approve: G-Q approved (edited if the contact selection changed) and G-OUT approved/edited or
 * rejected (`bad_email_draft`) per the toggle, then both executed — one transaction. G-OUT cannot be approved
 * without G-Q (service check here, DB trigger on email_drafts underneath).
 */
export async function approveCard(tx: TenantTx, actor: Actor, principal: Principal, cardId: string, input: ApproveInput) {
  const { gq, gout } = await loadCard(tx, cardId, true);
  if (gq.status !== "pending") throw new Problem("conflict", `Card is ${gq.status}`);
  if (cardHash(gq.content_hash, gout?.content_hash ?? null) !== input.contentHash) throw new Problem("precondition-failed", "Card changed since it was reviewed");
  const args = gq.action.args as GqArgs;

  // Re-validate against current state: flags or suppression since the card was made supersede it.
  const { rows: [acc] } = await tx.client.query<{ flags: string[]; status: string }>("SELECT flags, status FROM abcrm.accounts WHERE id = $1", [args.accountId]);
  if (acc!.status === "blocked" || acc!.flags.some((f) => ["competitor", "existing_buyer", "do_not_contact"].includes(f))) {
    await tx.client.query("SELECT abcrm.supersede_card($1, $2, 'account_flagged')", [tx.tenantId, cardId]);
    throw new Problem("conflict", "Account was flagged; card superseded");
  }
  const proposed = args.contacts.map((c) => c.contactId);
  const selected = input.contactIds ?? args.contacts.filter((c) => c.preselected).map((c) => c.contactId);
  if (!selected.length) throw new Problem("validation-failed", "Select at least one contact");
  if (selected.some((id) => !proposed.includes(id))) throw new Problem("validation-failed", "Contacts must come from the card");
  const { rows: inactive } = await tx.client.query("SELECT id FROM abcrm.contacts WHERE id = ANY($1) AND status <> 'active'", [selected]);
  if (inactive.length) throw new Problem("conflict", "A selected contact is suppressed");

  const sameSelection = selected.length === args.contacts.filter((c) => c.preselected).length && selected.every((id) => args.contacts.find((c) => c.contactId === id)?.preselected);
  const gqEdit = sameSelection ? undefined : { action: { tool: gq.action.tool, args: { ...args, contacts: args.contacts.map((c) => ({ ...c, preselected: selected.includes(c.contactId) })) } } };
  await approveDecision(tx, gq.id, principal, gq.content_hash, gqEdit);
  await executeApproved(tx, gq.id, (action) => EXECUTORS["account.approve_contact"]!(tx, actor, action, gq.id));

  let draftStatus: string | null = null;
  if (gout) {
    if (input.sendFirstEmail === false) {
      await rejectDecision(tx, gout.id, principal, "bad_email_draft", "Approved without the first email");
      await tx.client.query("UPDATE abcrm.email_drafts SET status = 'rejected' WHERE decision_id = $1", [gout.id]);
      draftStatus = "rejected";
    } else {
      const g = gout.action.args as GoutArgs;
      const subject = input.draft?.subject ?? g.subject;
      const body = input.draft?.body ?? g.body;
      if (!subject.trim() || subject.length > 120 || !body.trim() || body.length > 2500) throw new Problem("validation-failed", "Draft subject ≤ 120 and body ≤ 2500 characters");
      const contactId = selected.includes(g.contactId) ? g.contactId : selected[0]!;
      const changed = subject !== g.subject || body !== g.body || contactId !== g.contactId;
      const edit = changed ? { action: { tool: gout.action.tool, args: { ...g, subject, body, contactId, aiSpans: body === g.body ? g.aiSpans : [] } } } : undefined;
      await approveDecision(tx, gout.id, principal, gout.content_hash, edit);
      await executeApproved(tx, gout.id, (action) => EXECUTORS["email_draft.approve"]!(tx, actor, action, gout.id));
      draftStatus = changed ? "edited" : "approved";
    }
  }
  return {
    card_id: cardId,
    decisions: [{ id: gq.id, gate_id: "G-Q", status: "executed", edited: !!gqEdit }, ...(gout ? [{ id: gout.id, gate_id: "G-OUT", status: draftStatus === "rejected" ? "rejected" : "executed", edited: draftStatus === "edited" }] : [])],
    account: { id: args.accountId, status: "approved" },
    email_draft: gout ? { id: (gout.action.args as GoutArgs).draftId, status: draftStatus } : null,
  };
}

/** POST /cards/{id}/reject: both decisions rejected with a standard reason; the account goes back to prospect with a 90-day cooldown. */
export async function rejectCard(tx: TenantTx, principal: Principal, cardId: string, reason: RejectReason, note?: string) {
  if (!REJECT_REASONS.includes(reason)) throw new Problem("validation-failed", "Unknown reason_code");
  if (reason === "other" && !note?.trim()) throw new Problem("validation-failed", "A note is required for reason 'other'");
  const { gq, gout } = await loadCard(tx, cardId, true);
  if (gq.status !== "pending") throw new Problem("conflict", `Card is ${gq.status}`);
  const args = gq.action.args as GqArgs;
  await rejectDecision(tx, gq.id, principal, reason, note);
  if (gout?.status === "pending") {
    await rejectDecision(tx, gout.id, principal, reason, note);
    await tx.client.query("UPDATE abcrm.email_drafts SET status = 'rejected' WHERE decision_id = $1", [gout.id]);
  }
  await tx.client.query("UPDATE abcrm.accounts SET status = 'prospect', cooldown_until = now() + interval '90 days' WHERE id = $1 AND status = 'carded'", [args.accountId]);
  await tx.client.query("UPDATE abcrm.candidates SET status = 'rejected' WHERE id = $1", [args.candidateId]);
  // Quality breaker for the agent that produced the card (Q1 run of the scorecard).
  const { rows: [r] } = await tx.client.query<{ agent_definition_id: string }>(
    "SELECT agent_definition_id FROM abcrm.agent_runs WHERE id = $1", [gq.proposed_by.agentRunId ?? null]);
  if (r) await evaluateQualityBreaker(tx, r.agent_definition_id);
  return { card_id: cardId, status: "rejected", reason_code: reason };
}

export async function snoozeCard(tx: TenantTx, cardId: string, until: Date) {
  if (until.getTime() <= Date.now() || until.getTime() > Date.now() + 30 * 86_400_000) throw new Problem("validation-failed", "until must be within the next 30 days");
  const { gq } = await loadCard(tx, cardId, true);
  if (gq.status !== "pending") throw new Problem("conflict", `Card is ${gq.status}`);
  await tx.client.query("UPDATE abcrm.decisions SET snoozed_until = $2 WHERE card_id = $1 AND status = 'pending'", [cardId, until]);
  await tx.client.query("UPDATE abcrm.candidates SET status = 'snoozed' WHERE id = $1 AND status = 'carded'", [(gq.action.args as GqArgs).candidateId]);
  return { card_id: cardId, snoozed_until: until.toISOString() };
}

/**
 * POST /cards/bulk-approve (grouped review, D8): each card is approved in its own transaction with its default
 * selection, so every decision has its own record; cards whose hash changed are skipped and returned.
 */
export async function bulkApprove(pool: Pool, tenantId: string, actor: Actor, principal: Principal, cards: { cardId: string; contentHash: string }[]) {
  const approved: string[] = [];
  const skipped: { card_id: string; reason: string }[] = [];
  for (const c of cards) {
    try {
      await withTenant(pool, tenantId, actor, (tx) => approveCard(tx, actor, principal, c.cardId, { contentHash: c.contentHash }));
      approved.push(c.cardId);
    } catch (e) {
      if (e instanceof Problem && e.status !== 500) skipped.push({ card_id: c.cardId, reason: e.status === 412 ? "updated_review_again" : e.title });
      else throw e;
    }
  }
  return { approved, skipped };
}

type Executor = (tx: TenantTx, actor: Actor, action: { tool: string; args: Record<string, unknown> }, decisionId: string) => Promise<void>;

/** Executors for card decisions (tools.md §3.5). Registered with the app's executor map. */
export const EXECUTORS: Record<string, Executor> = {
  "account.approve_contact": async (tx, actor, action) => {
    const a = action.args as GqArgs;
    await tx.client.query("UPDATE abcrm.accounts SET status = 'approved' WHERE id = $1 AND status IN ('prospect', 'carded')", [a.accountId]);
    await tx.client.query("UPDATE abcrm.candidates SET status = 'approved' WHERE id = $1", [a.candidateId]);
    await emit(tx, "crm.account.approved_for_contact", { account_id: a.accountId, contact_ids: a.contacts.filter((c) => c.preselected).map((c) => c.contactId), by: actor.id });
  },
  "email_draft.approve": async (tx, _actor, action, decisionId) => {
    const g = action.args as GoutArgs;
    const edited = !!(await tx.client.query("SELECT 1 FROM abcrm.decisions WHERE id = $1 AND final_action IS NOT NULL", [decisionId])).rowCount;
    await tx.client.query(
      `UPDATE abcrm.email_drafts SET status = $2, subject = $3, body = $4, contact_id = $5, ai_spans = $6, content_hash = $7 WHERE id = $1`,
      [g.draftId, edited ? "edited" : "approved", g.subject, g.body, g.contactId, JSON.stringify(g.aiSpans), contentHash(g)]);
  },
};
