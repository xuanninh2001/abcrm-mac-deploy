import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring, uuidv7 } from "@abcrm/core";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { addSuppression, createAccount, createContact, setAccountFlags } from "@abcrm/crm";
import { ScriptedLlm } from "@abcrm/llm";
import { approveCard, bulkApprove, escalateCard, pickAssignee, getCard, listCards, proposeCard, reassignCard, rejectCard, snoozeCard, verifyCriterion, type CardDeps } from "../src/index.js";

let t: TestDb;
let playbookId: string;
let criterionId: string;
const keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));
const rep = randomUUID();
const viewer = randomUUID();
const rep2 = randomUUID();
const head = randomUUID();
const actor = { type: "user", id: rep } as const;
const principal = { type: "user", id: rep, role: "sales_rep" } as const;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, actor, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantB, actor, fn);

const W1 = { subject: "ACA data leads with TrustedForm", body: "Hi Ann,\n\nYou buy ACA leads from publishers. We supply ACA data leads with TrustedForm.\n\nOpen to a 50-lead test this month?\n\n{{sender_name}}",
  ai_spans: [{ start: 9, end: 45 }], personalization_basis: ["buys_leads"] };
const llm = new ScriptedLlm({ "w1.compose": () => W1 });
const deps = (): CardDeps => ({ pool: t.app, keyring, llm, messagingFor: async () => ({ angles: ["TrustedForm"], avoid: ["guaranteed"], cta_options: ["Open to a 50-lead test this month?"] }) });

/** A scored candidate with two contacts, the shape Q1 + S2 leave behind. */
async function scoredCandidate(domain: string, tier = "A") {
  return inA(async (tx) => {
    const { account } = await createAccount(tx, keyring, actor, { name: domain, domain });
    const ids: string[] = [];
    for (const [first, title] of [["Ann", "Affiliate Manager"], ["Bo", "Director of Partnerships"]] as const) {
      const { contact } = await createContact(tx, keyring, actor, account.id, { firstName: first, title, email: `${first.toLowerCase()}@${domain}`, source: { kind: "provider" } });
      await tx.client.query(`UPDATE abcrm.contacts SET email_verification = '{"result":"valid"}' WHERE id = $1`, [contact.id]);
      ids.push(contact.id);
    }
    const candidate = uuidv7();
    const scorecard = uuidv7();
    await tx.client.query(`INSERT INTO abcrm.candidates(id, tenant_id, account_id, discovered_via, status) VALUES ($1, $2, $3, '{"kind":"manual"}', 'scored')`, [candidate, tx.tenantId, account.id]);
    await tx.client.query(`INSERT INTO abcrm.scorecards(id, tenant_id, candidate_id, account_id, playbook_id, playbook_version, total_score, tier, summary)
      VALUES ($1, $2, $3, $4, $5, 1, 90, $6, '- Buys ACA leads from publishers')`, [scorecard, tx.tenantId, candidate, account.id, playbookId, tier]);
    await tx.client.query("UPDATE abcrm.candidates SET scorecard_id = $2 WHERE id = $1", [candidate, scorecard]);
    const ev = uuidv7();
    await tx.client.query(`INSERT INTO abcrm.evidence(id, tenant_id, account_id, kind, url, retrieved_at, snippet, content_hash) VALUES ($1, $2, $3, 'web_page', 'https://x/p', now(), 'We buy ACA leads from publishers.', $4)`,
      [ev, tx.tenantId, account.id, Buffer.from(randomUUID())]);
    await tx.client.query(`INSERT INTO abcrm.criterion_results(id, tenant_id, scorecard_id, criterion_id, result, quotes) VALUES ($1, $2, $3, $4, 'pass', $5)`,
      [uuidv7(), tx.tenantId, scorecard, criterionId, JSON.stringify([{ evidence_id: ev, text: "We buy ACA leads from publishers.", verified: true }])]);
    const lookup = uuidv7();
    await tx.client.query(`INSERT INTO abcrm.contact_lookups(id, tenant_id, account_id, candidate_id, titles, limit_n, status, results) VALUES ($1, $2, $3, $4, '{x}', 2, 'completed', $5)`,
      [lookup, tx.tenantId, account.id, candidate, JSON.stringify([{ contactId: ids[0], preselected: true }, { contactId: ids[1], preselected: false }])]);
    return { accountId: account.id, candidateId: candidate, contacts: ids };
  });
}

beforeAll(async () => {
  t = await setupTestDb();
  const ins = "INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, $3, $4, $5)";
  await t.admin.query(ins, [rep, t.tenantA, "r", "rep@a.vn", "sales_rep"]);
  await t.admin.query(ins, [viewer, t.tenantA, "v", "v@a.vn", "viewer"]);
  playbookId = uuidv7();
  criterionId = uuidv7();
  await t.admin.query(`INSERT INTO abcrm.playbooks(id, tenant_id, lineage_id, name, version, status, definition_hash) VALUES ($1, $2, $1, 'PB', 1, 'draft', 'h')`, [playbookId, t.tenantA]);
  await t.admin.query(`INSERT INTO abcrm.criteria(id, tenant_id, playbook_id, key, name, description, kind, evaluation, order_no) VALUES ($1, $2, $3, 'buys_leads', 'Buys leads', 'd', 'must_have', 'ai_judged', 0)`,
    [criterionId, t.tenantA, playbookId]);
  await t.admin.query("UPDATE abcrm.playbooks SET status = 'active' WHERE id = $1", [playbookId]);
});
afterAll(async () => { await t?.close(); });

describe("card proposal", () => {
  it("writes the first email, proposes G-Q + G-OUT on one card, cards the account and charges 2 credits once", async () => {
    const c = await scoredCandidate("buyer1.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    expect(r.status).toBe("proposed");
    if (r.status !== "proposed") throw new Error("unreachable");
    expect(await proposeCard(deps(), t.tenantA, c.candidateId)).toEqual(r);   // retry → same card

    const card = await inA((tx) => getCard(tx, keyring, r.cardId));
    expect(card.decisions.map((d) => [d.gate_id, d.status])).toEqual([["G-Q", "pending"], ["G-OUT", "pending"]]);
    expect(card.account).toMatchObject({ status: "carded" });
    expect(card.contacts.map((x) => [x.first_name, x.email, x.preselected])).toEqual([["Ann", "ann@buyer1.com", true], ["Bo", "bo@buyer1.com", false]]);
    expect(card.email_draft).toMatchObject({ subject: W1.subject, status: "proposed" });
    expect(card.scorecard.criteria[0].quotes[0]).toMatchObject({ text: "We buy ACA leads from publishers.", url: "https://x/p" });
    const facts = await inA(async (tx) => ({
      usage: (await tx.client.query("SELECT credits::int AS c FROM abcrm.usage_events WHERE idempotency_key = $1", [`card:${c.candidateId}`])).rows,
      dec: (await tx.client.query("SELECT gate_id, lane, assignee_role, expires_at > now() + interval '13 days' AS ttl, sla_due_at > now() AS sla FROM abcrm.decisions WHERE card_id = $1 ORDER BY gate_id", [r.cardId])).rows,
    }));
    expect(facts.usage).toEqual([{ c: 2 }]);
    const res = await t.admin.query("SELECT count(*)::int AS open FROM abcrm.usage_reservations WHERE status = 'reserved'");
    expect(res.rows[0].open).toBe(0);
    expect(facts.dec).toEqual([
      { gate_id: "G-OUT", lane: "contact", assignee_role: "sales_rep", ttl: true, sla: true },
      { gate_id: "G-Q", lane: "contact", assignee_role: "sales_rep", ttl: true, sla: true }]);

    const list = await inA((tx) => listCards(tx, { limit: 50 }));
    expect(list.find((x) => x.card_id === r.cardId)).toMatchObject({ tier: "A", contact: { title: "Affiliate Manager", email_status: "valid" }, has_draft: true,
      top_reason: "Buys ACA leads from publishers", content_hash: card.content_hash });
    await expect(inB((tx) => getCard(tx, keyring, r.cardId))).rejects.toMatchObject({ status: 404 });
  });

  it("skips below card_min_tier and without contacts", async () => {
    const c = await scoredCandidate("lowtier.com", "C");
    expect(await proposeCard(deps(), t.tenantA, c.candidateId)).toEqual({ status: "skipped", reason: "below_card_min_tier" });
  });

  it("without an LLM the card carries G-Q only", async () => {
    const c = await scoredCandidate("nollm.com");
    const r = await proposeCard({ ...deps(), llm: null }, t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error(JSON.stringify(r));
    const card = await inA((tx) => getCard(tx, keyring, r.cardId));
    expect(card.decisions.map((d) => d.gate_id)).toEqual(["G-Q"]);
    expect(card.email_draft).toBeNull();
  });
});

describe("approve / reject / snooze", () => {
  it("approves with an edited contact selection and draft; executes both exactly once", async () => {
    const c = await scoredCandidate("approve.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    const card = await inA((tx) => getCard(tx, keyring, r.cardId));
    await expect(inA((tx) => approveCard(tx, actor, principal, r.cardId, { contentHash: "0".repeat(64) }))).rejects.toMatchObject({ status: 412 });
    await expect(inA((tx) => approveCard(tx, actor, { type: "user", id: viewer, role: "viewer" }, r.cardId, { contentHash: card.content_hash }))).rejects.toMatchObject({ status: 403 });
    await expect(inA((tx) => approveCard(tx, actor, principal, r.cardId, { contentHash: card.content_hash, contactIds: [randomUUID()] }))).rejects.toMatchObject({ status: 422 });

    const res = await inA((tx) => approveCard(tx, actor, principal, r.cardId, {
      contentHash: card.content_hash, contactIds: [c.contacts[1]!], draft: { subject: "Quick question, Bo", body: "Hi Bo,\n\nOpen to a test?" } }));
    expect(res).toMatchObject({ account: { status: "approved" }, email_draft: { status: "edited" } });
    expect(res.decisions).toEqual([{ id: expect.any(String), gate_id: "G-Q", status: "executed", edited: true }, { id: expect.any(String), gate_id: "G-OUT", status: "executed", edited: true }]);
    const after = await inA((tx) => getCard(tx, keyring, r.cardId));
    expect(after.email_draft).toMatchObject({ status: "edited", subject: "Quick question, Bo", contact_id: c.contacts[1] });
    expect(after.account).toMatchObject({ status: "approved" });
    await expect(inA((tx) => approveCard(tx, actor, principal, r.cardId, { contentHash: after.content_hash }))).rejects.toMatchObject({ status: 409 });
  });

  it("approve without the email rejects G-OUT as bad_email_draft", async () => {
    const c = await scoredCandidate("noemail.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    const card = await inA((tx) => getCard(tx, keyring, r.cardId));
    const res = await inA((tx) => approveCard(tx, actor, principal, r.cardId, { contentHash: card.content_hash, sendFirstEmail: false }));
    expect(res.email_draft).toMatchObject({ status: "rejected" });
    const d = await t.admin.query("SELECT reject_reason_code FROM abcrm.decisions WHERE card_id = $1 AND gate_id = 'G-OUT'", [r.cardId]);
    expect(d.rows[0].reject_reason_code).toBe("bad_email_draft");
  });

  it("the database refuses an approved email draft without an approved G-Q", async () => {
    const c = await scoredCandidate("invariant.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    await expect(inA((tx) => tx.client.query(
      "UPDATE abcrm.email_drafts SET status = 'approved' WHERE decision_id IN (SELECT id FROM abcrm.decisions WHERE card_id = $1)", [r.cardId])))
      .rejects.toThrow(/without an approved G-Q/);
  });

  it("reject needs a standard reason, puts the account on cooldown and frees the candidate", async () => {
    const c = await scoredCandidate("reject.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    await expect(inA((tx) => rejectCard(tx, principal, r.cardId, "other"))).rejects.toMatchObject({ status: 422 });
    await expect(inA((tx) => rejectCard(tx, principal, r.cardId, "nope" as never))).rejects.toMatchObject({ status: 422 });
    await inA((tx) => rejectCard(tx, principal, r.cardId, "too_small"));
    const s = await t.admin.query("SELECT a.status, a.cooldown_until > now() + interval '89 days' AS cool, c.status AS cand FROM abcrm.accounts a JOIN abcrm.candidates c ON c.account_id = a.id WHERE a.id = $1", [c.accountId]);
    expect(s.rows[0]).toEqual({ status: "prospect", cool: true, cand: "rejected" });
    const drafts = await t.admin.query("SELECT ed.status FROM abcrm.email_drafts ed JOIN abcrm.decisions d ON d.id = ed.decision_id WHERE d.card_id = $1", [r.cardId]);
    expect(drafts.rows[0].status).toBe("rejected");
  });

  it("snoozed cards leave the inbox until the time passes", async () => {
    const c = await scoredCandidate("snooze.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    await inA((tx) => snoozeCard(tx, r.cardId, new Date(Date.now() + 86_400_000)));
    expect((await inA((tx) => listCards(tx, { limit: 200 }))).map((x) => x.card_id)).not.toContain(r.cardId);
    expect((await inA((tx) => listCards(tx, { limit: 200, includeSnoozed: true }))).map((x) => x.card_id)).toContain(r.cardId);
    await expect(inA((tx) => snoozeCard(tx, r.cardId, new Date(Date.now() - 1000)))).rejects.toMatchObject({ status: 422 });
  });
});

describe("grouped review, supersede and expiry", () => {
  it("bulk approve approves each card separately and skips changed ones", async () => {
    const a = await scoredCandidate("bulk1.com");
    const b = await scoredCandidate("bulk2.com");
    const ra = await proposeCard(deps(), t.tenantA, a.candidateId);
    const rb = await proposeCard(deps(), t.tenantA, b.candidateId);
    if (ra.status !== "proposed" || rb.status !== "proposed") throw new Error("unreachable");
    const ha = (await inA((tx) => getCard(tx, keyring, ra.cardId))).content_hash;
    const res = await bulkApprove(t.app, t.tenantA, actor, principal, [{ cardId: ra.cardId, contentHash: ha }, { cardId: rb.cardId, contentHash: "f".repeat(64) }]);
    expect(res).toEqual({ approved: [ra.cardId], skipped: [{ card_id: rb.cardId, reason: "updated_review_again" }] });
    const n = await t.admin.query("SELECT count(*)::int AS n FROM abcrm.decisions WHERE card_id = $1 AND status = 'executed' AND decided_by = $2", [ra.cardId, rep]);
    expect(n.rows[0].n).toBe(2);
  });

  it("flagging the account or suppressing a proposed contact supersedes the pending card", async () => {
    const a = await scoredCandidate("flagme.com");
    const ra = await proposeCard(deps(), t.tenantA, a.candidateId);
    if (ra.status !== "proposed") throw new Error("unreachable");
    await inA((tx) => setAccountFlags(tx, actor, a.accountId, ["competitor"], []));
    const s = await t.admin.query("SELECT status FROM abcrm.decisions WHERE card_id = $1", [ra.cardId]);
    expect(s.rows.map((r) => r.status)).toEqual(["superseded", "superseded"]);
    expect((await t.admin.query("SELECT status FROM abcrm.accounts WHERE id = $1", [a.accountId])).rows[0].status).toBe("prospect");

    const b = await scoredCandidate("suppressme.com");
    const rb = await proposeCard(deps(), t.tenantA, b.candidateId);
    if (rb.status !== "proposed") throw new Error("unreachable");
    await inA((tx) => addSuppression(tx, keyring, actor, { kind: "email", value: "ann@suppressme.com", reason: "unsubscribe" }));
    const s2 = await t.admin.query("SELECT status, reject_note FROM abcrm.decisions WHERE card_id = $1", [rb.cardId]);
    expect(s2.rows.map((r) => r.status)).toEqual(["superseded", "superseded"]);
    expect(s2.rows[0].reject_note).toBe("contact_suppressed");
  });

  it("expire_due_decisions expires pending cards past their TTL", async () => {
    const a = await scoredCandidate("expire.com");
    const ra = await proposeCard(deps(), t.tenantA, a.candidateId);
    if (ra.status !== "proposed") throw new Error("unreachable");
    await t.admin.query("UPDATE abcrm.decisions SET expires_at = now() - interval '1 minute' WHERE card_id = $1", [ra.cardId]);
    const { rows } = await t.app.query("SELECT * FROM abcrm.expire_due_decisions(100)");
    expect(rows.filter((r) => r.card_id === ra.cardId)).toHaveLength(2);
    const s = await t.admin.query("SELECT d.status, a.status AS account FROM abcrm.decisions d JOIN abcrm.accounts a ON a.id = $2 WHERE d.card_id = $1", [ra.cardId, a.accountId]);
    expect(s.rows).toEqual([{ status: "expired", account: "prospect" }, { status: "expired", account: "prospect" }]);
  });
});

describe("routing, SLA and escalation", () => {
  it("assigns round-robin with a working-hours SLA; reps see their own and unassigned cards", async () => {
    const ins = "INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role, timezone) VALUES ($1, $2, $3, $4, $5, $6)";
    await t.admin.query(ins, [rep2, t.tenantA, "r2", "rep2@a.vn", "sales_rep", "America/New_York"]);
    await t.admin.query(ins, [head, t.tenantA, "h", "head@a.vn", "head_of_bd", "Asia/Ho_Chi_Minh"]);
    const c = await scoredCandidate("route1.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    const card = await inA((tx) => getCard(tx, keyring, r.cardId));
    expect([rep, rep2]).toContain(card.assignee_user_id);
    expect(card.sla_due_at!.getTime()).toBeGreaterThan(Date.now());
    // Reps at work come first; among them, fewest pending cards.
    const hcmMorning = new Date("2026-10-26T03:00:00Z");   // 10:00 Ho Chi Minh, 23:00 Sunday New York
    const nyMorning = new Date("2026-10-26T15:00:00Z");    // 22:00 Ho Chi Minh, 11:00 New York
    expect((await inA((tx) => pickAssignee(tx, { now: hcmMorning })))!.id).toBe(rep);
    expect((await inA((tx) => pickAssignee(tx, { now: nyMorning })))!.id).toBe(rep2);
    const other = card.assignee_user_id === rep ? rep2 : rep;
    const mine = await inA((tx) => listCards(tx, { limit: 200, viewer: { id: card.assignee_user_id!, role: "sales_rep" } }));
    expect(mine.map((x) => x.card_id)).toContain(r.cardId);
    const theirs = await inA((tx) => listCards(tx, { limit: 200, viewer: { id: other, role: "sales_rep" } }));
    expect(theirs.map((x) => x.card_id)).not.toContain(r.cardId);
    const asHead = await inA((tx) => listCards(tx, { limit: 200, viewer: { id: head, role: "head_of_bd" } }));
    expect(asHead.map((x) => x.card_id)).toContain(r.cardId);
  });

  it("reassign needs decisions.reassign and notifies the new assignee", async () => {
    const c = await scoredCandidate("route2.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    await expect(inA((tx) => reassignCard(tx, principal, r.cardId, head))).rejects.toMatchObject({ status: 403 });
    const res = await inA((tx) => reassignCard(tx, { type: "user", id: head, role: "head_of_bd" }, r.cardId, rep));
    expect(res.assignee_user_id).toBe(rep);
    const n = await t.admin.query("SELECT kind, payload FROM abcrm.notifications WHERE user_id = $1 AND kind = 'card_assigned'", [rep]);
    expect(n.rows.map((x) => x.payload.card_id)).toContain(r.cardId);
    await expect(inA((tx) => reassignCard(tx, { type: "user", id: head, role: "head_of_bd" }, r.cardId, viewer))).rejects.toMatchObject({ status: 422 });
  });

  it("overdue cards notify the assignee, then move to another rep at work and alert heads of BD", async () => {
    const c = await scoredCandidate("overdue.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    await inA((tx) => reassignCard(tx, { type: "user", id: head, role: "head_of_bd" }, r.cardId, rep));
    await t.admin.query("UPDATE abcrm.decisions SET sla_due_at = now() - interval '5 hours' WHERE card_id = $1", [r.cardId]);
    const due = await t.app.query("SELECT * FROM abcrm.due_escalations()");
    const gq = due.rows.find((x) => x.card_id === r.cardId);
    expect(gq).toMatchObject({ level: 0 });
    // Monday 10:00 in Ho Chi Minh: rep (HCM) at work; rep2 (New York) is not.
    const monday = new Date("2026-10-26T03:00:00Z");
    expect(await inA((tx) => escalateCard(tx, gq.decision_id, monday))).toEqual({ level: 1, assignee: rep });
    expect((await t.admin.query("SELECT count(*)::int AS n FROM abcrm.notifications WHERE user_id = $1 AND kind = 'card_overdue'", [rep])).rows[0].n).toBe(1);
    const second = await inA((tx) => escalateCard(tx, gq.decision_id, monday));
    expect(second).toEqual({ level: 2, assignee: head });   // no other rep at work → head of BD
    expect((await t.admin.query("SELECT assignee_user_id, escalation_level FROM abcrm.decisions WHERE card_id = $1", [r.cardId])).rows)
      .toEqual([{ assignee_user_id: head, escalation_level: 2 }, { assignee_user_id: head, escalation_level: 2 }]);
    expect(await inA((tx) => escalateCard(tx, gq.decision_id, monday))).toBeNull();
  });

  it("reps can mark an unknown criterion as verified without changing the scorecard", async () => {
    const c = await scoredCandidate("verify.com");
    const r = await proposeCard(deps(), t.tenantA, c.candidateId);
    if (r.status !== "proposed") throw new Error("unreachable");
    await expect(inA((tx) => verifyCriterion(tx, principal, r.cardId, "buys_leads", "Called them"))).rejects.toMatchObject({ status: 409 });
    await t.admin.query("UPDATE abcrm.criterion_results SET result = 'unknown' WHERE scorecard_id = (SELECT scorecard_id FROM abcrm.candidates WHERE id = $1)", [c.candidateId]);
    await inA((tx) => verifyCriterion(tx, principal, r.cardId, "buys_leads", "Confirmed on a call: they buy ACA leads"));
    const card = await inA((tx) => getCard(tx, keyring, r.cardId));
    expect(card.scorecard.criteria[0]).toMatchObject({ result: "unknown", verified_by: [{ user_id: rep, note: "Confirmed on a call: they buy ACA leads" }] });
    await expect(inA((tx) => verifyCriterion(tx, { type: "user", id: viewer, role: "viewer" }, r.cardId, "buys_leads", "x"))).rejects.toMatchObject({ status: 403 });
  });
});

describe("INV-1 (property)", () => {
  type Op = "approve" | "approve_no_email" | "approve_edited" | "approve_stale" | "reject" | "flag" | "snooze" | "force_draft";
  let n = 0;
  it("no sequence of card actions leaves an approved email without an approved G-Q on the same card", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom<Op>("approve", "approve_no_email", "approve_edited", "approve_stale", "reject", "flag", "snooze", "force_draft"), { minLength: 1, maxLength: 4 }),
      async (ops) => {
        const c = await scoredCandidate(`inv1-${n++}.com`);
        const r = await proposeCard(deps(), t.tenantA, c.candidateId);
        if (r.status !== "proposed") throw new Error("unreachable");
        for (const op of ops) {
          const hash = async () => (await inA((tx) => getCard(tx, keyring, r.cardId))).content_hash;
          await (async () => {
            switch (op) {
              case "approve": return inA(async (tx) => approveCard(tx, actor, principal, r.cardId, { contentHash: await hash() }));
              case "approve_no_email": return inA(async (tx) => approveCard(tx, actor, principal, r.cardId, { contentHash: await hash(), sendFirstEmail: false }));
              case "approve_edited": return inA(async (tx) => approveCard(tx, actor, principal, r.cardId, { contentHash: await hash(), draft: { subject: "Quick question", body: "Hi,\n\nOpen to a test?" } }));
              case "approve_stale": return inA((tx) => approveCard(tx, actor, principal, r.cardId, { contentHash: "0".repeat(64) }));
              case "reject": return inA((tx) => rejectCard(tx, principal, r.cardId, "too_small"));
              case "flag": return inA((tx) => setAccountFlags(tx, actor, c.accountId, ["do_not_contact"], []));
              case "snooze": return inA((tx) => snoozeCard(tx, r.cardId, new Date(Date.now() + 3_600_000)));
              // A bug or a bad script writing the draft status directly must be stopped by the database.
              case "force_draft": return inA((tx) => tx.client.query(
                "UPDATE abcrm.email_drafts SET status = 'approved' WHERE decision_id IN (SELECT id FROM abcrm.decisions WHERE card_id = $1)", [r.cardId]));
            }
          })().catch(() => undefined);   // refused actions are part of the property
        }
        const { rows: [v] } = await t.admin.query(`
          SELECT count(*)::int AS n FROM abcrm.email_drafts e JOIN abcrm.decisions g ON g.id = e.decision_id
          WHERE g.card_id = $1 AND e.status IN ('approved','edited','queued','sent')
            AND NOT EXISTS (SELECT 1 FROM abcrm.decisions q WHERE q.card_id = g.card_id AND q.gate_id = 'G-Q' AND q.status IN ('approved','edited','executed'))`, [r.cardId]);
        expect(v.n).toBe(0);
      }), { numRuns: 25 });
  }, 120_000);
});
