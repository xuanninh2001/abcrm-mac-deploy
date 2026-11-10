import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedLlm, type LlmRequest } from "@abcrm/llm";
import { uuidv7 } from "@abcrm/core";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { createManualCandidate, getPreview, getScorecard, listAccountScorecards, qualifyCandidate, requestPreview, runPreview, type PageSource } from "../src/index.js";

let t: TestDb;
let playbookId: string;
let runId: string;
const userId = randomUUID();
const actor = { type: "user", id: userId } as const;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, actor, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantB, actor, fn);

const CRITERIA = [
  { key: "us_operating", kind: "knockout", evaluation: "rule", rule: { "==": [{ var: "account.hq_country" }, "US"] }, evidence_required: false },
  { key: "not_competitor", kind: "knockout", evaluation: "ai_judged", hints: ["home"] },
  { key: "buys_leads", kind: "must_have", evaluation: "ai_judged", hints: ["publishers"] },
  { key: "offshore", kind: "scored", evaluation: "ai_judged", weight: 50, unknown_policy: "neutral" },
  { key: "uses_tech", kind: "scored", evaluation: "rule", weight: 50, evidence_required: false,
    rule: { some: [{ var: "account.tech_signal_keys" }, { in: [{ var: "" }, ["trustedform"]] }] } },
];

async function seedPlaybook(tx: TenantTx, status: string) {
  const id = uuidv7();
  await tx.client.query(`INSERT INTO abcrm.playbooks(id, tenant_id, lineage_id, name, version, status, definition_hash) VALUES ($1, $2, $1, 'PB', 1, 'draft', 'h1')`, [id, tx.tenantId]);
  let n = 0;
  for (const c of CRITERIA) {
    await tx.client.query(
      `INSERT INTO abcrm.criteria(id, tenant_id, playbook_id, key, name, description, kind, evaluation, rule, weight, evidence_required, unknown_policy, hints, order_no)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [uuidv7(), tx.tenantId, id, c.key, `Company ${c.key.replace(/_/g, " ")} publishers leads`, c.kind, c.evaluation, c.rule ?? null, c.weight ?? 0,
        c.evidence_required ?? true, c.unknown_policy ?? "neutral", c.hints ?? [], n++]);
  }
  await tx.client.query("UPDATE abcrm.playbooks SET status = $2 WHERE id = $1", [id, status]);
  return id;
}

async function seedAccount(tx: TenantTx, domain: string, hq = "US") {
  const id = uuidv7();
  await tx.client.query(
    `INSERT INTO abcrm.accounts(id, tenant_id, name, domain, domain_bidx, hq_country, tech_signals) VALUES ($1, $2, $3, $3, $4, $5, '{"trustedform": {}}')`,
    [id, tx.tenantId, domain, Buffer.from(randomUUID()), hq]);
  await tx.client.query(
    `INSERT INTO abcrm.evidence(id, tenant_id, account_id, kind, url, retrieved_at, snippet, content_hash) VALUES ($1, $2, $3, 'web_page', $4, now(), $5, $6)`,
    [uuidv7(), tx.tenantId, id, `https://${domain}/publishers`, "We buy ACA and final expense leads from publishers via ping post.", Buffer.from(randomUUID())]);
  return id;
}

async function seedCandidate(tx: TenantTx, accountId: string) {
  const id = uuidv7();
  await tx.client.query(`INSERT INTO abcrm.candidates(id, tenant_id, sourcing_run_id, account_id, discovered_via, status) VALUES ($1, $2, $3, $4, '{"kind":"search"}', 'found')`,
    [id, tx.tenantId, runId, accountId]);
  return id;
}

const keysOf = (req: LlmRequest<unknown>) => req.user.match(/Evaluate these criteria: (.*)\./)![1]!.split(", ");
const pass = (text: string, req: LlmRequest<unknown>) => {
  const blocks = [...req.user.matchAll(/evidence_id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/untrusted_data>/g)];
  const id = blocks.find((b) => b[2]!.includes(text))?.[1] ?? "x";
  return { result: "pass", confidence: 0.9, rationale: "Stated.", quotes: [{ evidence_id: id, text }] };
};
const llm = () => new ScriptedLlm({
  "q1.judge": (req) => ({ injection_suspected: false, results: keysOf(req).map((k) => ({ criterion_key: k, ...pass("buy ACA and final expense leads from publishers", req) })) }),
  "q1.summary": () => ({ why_fit: ["Buys ACA leads from publishers"], risks: ["Offshore policy not stated"] }),
});

beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'h', 'h@a.vn', 'head_of_bd')", [userId, t.tenantA]);
  playbookId = await inA((tx) => seedPlaybook(tx, "active"));
  runId = await inA(async (tx) => {
    const ipp = uuidv7();
    await tx.client.query(`INSERT INTO abcrm.ipps(id, tenant_id, lineage_id, name, version, status, vertical, lead_types, buyer_types, contact_titles, playbook_id)
      VALUES ($1, $2, $1, 'IPP', 1, 'active', 'insurance', '{aca_health}', '{aggregator}', '{Affiliate Manager}', $3)`, [ipp, tx.tenantId, playbookId]);
    const run = uuidv7();
    await tx.client.query(`INSERT INTO abcrm.sourcing_runs(id, tenant_id, ipp_id, target_count, agent_credit_budget, contact_credit_budget, status) VALUES ($1, $2, $3, 10, 100, 10, 'running')`,
      [run, tx.tenantId, ipp]);
    return run;
  });
});
afterAll(async () => { await t?.close(); });

describe("qualifyCandidate", () => {
  it("scores a candidate, persists an immutable scorecard, meters, costs and emits", async () => {
    const accountId = await inA((tx) => seedAccount(tx, "buyer.com"));
    const candidateId = await inA((tx) => seedCandidate(tx, accountId));
    const pages: PageSource = { pagesFor: async () => [{ url: "https://buyer.com/", pageId: randomUUID(), text: "Publishers worldwide welcome.\nWe work with lead publishers and call centers in the Philippines and India." }] };
    const gw = llm();
    const r = await qualifyCandidate({ pool: t.app, llm: gw, pages }, t.tenantA, candidateId, { eventId: randomUUID() });
    expect(r).toMatchObject({ status: "scored", tier: "A", cardEligible: true, existing: false });
    if (r.status !== "scored") throw new Error("unreachable");

    const sc = await inA((tx) => getScorecard(tx, r.scorecardId));
    expect(sc).toMatchObject({ tier: "A", total_score: 100, playbook_id: playbookId });
    expect(sc.summary).toContain("Why fit:");
    expect(sc.criteria.map((c: { key: string; result: string }) => [c.key, c.result])).toEqual([
      ["us_operating", "pass"], ["not_competitor", "pass"], ["buys_leads", "pass"], ["offshore", "pass"], ["uses_tech", "pass"]]);
    expect(sc.criteria.find((c: { key: string }) => c.key === "buys_leads").quotes[0]).toMatchObject({ verified: true });

    const facts = await inA(async (tx) => ({
      cand: (await tx.client.query("SELECT status, scorecard_id FROM abcrm.candidates WHERE id = $1", [candidateId])).rows[0],
      usage: (await tx.client.query("SELECT action_type, credits::int AS c FROM abcrm.usage_events WHERE idempotency_key LIKE 'q1:%'")).rows,
      costs: (await tx.client.query("SELECT count(*)::int AS n FROM abcrm.cost_ledger WHERE kind = 'llm'")).rows[0].n,
      evidence: (await tx.client.query("SELECT count(*)::int AS n FROM abcrm.evidence WHERE account_id = $1", [accountId])).rows[0].n,
      event: (await tx.client.query("SELECT payload FROM abcrm.outbox WHERE topic = 'qualification.scorecard.created'")).rows[0]?.payload,
      run: (await tx.client.query("SELECT status, agent_credits::int AS c, tokens FROM abcrm.agent_runs WHERE id = (SELECT agent_run_id FROM abcrm.scorecards WHERE id = $1)", [r.scorecardId])).rows[0],
      stats: (await tx.client.query("SELECT stats FROM abcrm.sourcing_runs WHERE id = $1", [runId])).rows[0].stats,
    }));
    expect(facts.cand).toEqual({ status: "scored", scorecard_id: r.scorecardId });
    expect(facts.usage).toEqual([{ action_type: "scorecard_ai", c: 4 }]);
    expect(facts.costs).toBe(gw.calls.length);
    expect(facts.evidence).toBe(2);   // seeded + one passage from the targeted fetch
    expect(facts.event).toMatchObject({ scorecard_id: r.scorecardId, tier: "A", card_eligible: true });
    expect(facts.run).toMatchObject({ status: "completed", c: 4 });
    expect(facts.stats).toMatchObject({ qualified: 1, agent_credits_used: 4 });
    const bal = await t.admin.query("SELECT sum(reserved)::float AS r, sum(used)::float AS u FROM abcrm.usage_balances WHERE tenant_id = $1 AND meter = 'agent'", [t.tenantA]);
    expect(bal.rows[0]).toEqual({ r: 0, u: 4 });   // reservation settled into the actual charge

    // Retry: same scorecard, no new LLM calls, no second charge.
    const calls = gw.calls.length;
    const again = await qualifyCandidate({ pool: t.app, llm: gw, pages }, t.tenantA, candidateId);
    expect(again).toMatchObject({ status: "scored", scorecardId: r.scorecardId, existing: true });
    expect(gw.calls.length).toBe(calls);
    // Scorecards are immutable for the app role.
    await expect(inA((tx) => tx.client.query("UPDATE abcrm.scorecards SET tier = 'D' WHERE id = $1", [r.scorecardId]))).rejects.toThrow(/permission denied/);
  });

  it("knockout by rule costs 1 credit and makes no LLM call; tenant isolation holds", async () => {
    const accountId = await inA((tx) => seedAccount(tx, "canada.com", "CA"));
    const candidateId = await inA((tx) => seedCandidate(tx, accountId));
    const gw = llm();
    const r = await qualifyCandidate({ pool: t.app, llm: gw }, t.tenantA, candidateId);
    expect(r).toMatchObject({ status: "scored", tier: "D", cardEligible: false });
    expect(gw.calls).toHaveLength(0);
    expect(await inA((tx) => listAccountScorecards(tx, accountId))).toHaveLength(1);
    await expect(inB((tx) => listAccountScorecards(tx, accountId))).rejects.toMatchObject({ status: 404 });
    expect(await qualifyCandidate({ pool: t.app, llm: gw }, t.tenantB, candidateId)).toEqual({ status: "skipped", reason: "candidate_not_found" });
  });

  it("honours the kill switch and qualifies manual candidates with the active playbook", async () => {
    const accountId = await inA((tx) => seedAccount(tx, "manual.com"));
    const { candidateId } = await inA((tx) => createManualCandidate(tx, actor, accountId, "met at LeadsCon"));
    await t.admin.query("UPDATE abcrm.tenants SET kill_switch = true WHERE id = $1", [t.tenantA]);
    expect(await qualifyCandidate({ pool: t.app, llm: llm() }, t.tenantA, candidateId)).toEqual({ status: "skipped", reason: "kill_switch" });
    await t.admin.query("UPDATE abcrm.tenants SET kill_switch = false WHERE id = $1", [t.tenantA]);
    expect(await qualifyCandidate({ pool: t.app, llm: llm() }, t.tenantA, candidateId)).toMatchObject({ status: "scored", tier: "A" });
  });
});

describe("playbook preview", () => {
  it("runs a draft playbook on recent accounts without writing scorecards", async () => {
    const draftId = await inA((tx) => seedPlaybook(tx, "draft"));
    const before = await inA(async (tx) => (await tx.client.query("SELECT count(*)::int AS n FROM abcrm.scorecards")).rows[0].n);
    const pv = await inA((tx) => requestPreview(tx, actor, draftId, { sample: "recent", size: 10 }));
    expect(pv.status).toBe("running");
    await runPreview({ pool: t.app, llm: llm() }, t.tenantA, pv.id);
    const done = await inA((tx) => getPreview(tx, pv.id));
    expect(done.status).toBe("completed");
    expect(done.results).toHaveLength(3);
    expect(done.tier_distribution).toEqual({ A: 2, B: 0, C: 0, D: 1 });
    expect(Number(done.agent_credits)).toBe(4 + 4 + 1);
    const after = await inA(async (tx) => (await tx.client.query("SELECT count(*)::int AS n FROM abcrm.scorecards")).rows[0].n);
    expect(after).toBe(before);
    await expect(inA((tx) => requestPreview(tx, actor, draftId, { sample: "golden", size: 10 }))).rejects.toMatchObject({ status: 422 });
    await expect(inB((tx) => getPreview(tx, pv.id))).rejects.toMatchObject({ status: 404 });
  });
});
