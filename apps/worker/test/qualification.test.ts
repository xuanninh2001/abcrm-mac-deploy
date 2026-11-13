import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring, uuidv7 } from "@abcrm/core";
import { withTenant } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { cloneFromPack } from "@abcrm/setup";
import { createAccount } from "@abcrm/crm";
import { ScriptedLlm, type LlmRequest } from "@abcrm/llm";
import { PlatformKeys, StaticContactProvider } from "@abcrm/contactdata";
import { requestPreview } from "@abcrm/qualification";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { launchEngine, shutdownEngine } from "../src/engine.js";
import { dispatchOnce } from "../src/dispatcher.js";
import { registerQualification } from "../src/workflows/qualification.js";

let t: TestDb;
let playbookId: string;
let runId: string;
const userId = randomUUID();
const actor = { type: "user", id: userId } as const;
const keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));

// Every AI criterion passes with a quote from the evidence block that contains it.
const llm = new ScriptedLlm({
  "q1.judge": (req: LlmRequest<unknown>) => {
    const keys = req.user.match(/Evaluate these criteria: (.*)\./)![1]!.split(", ");
    const id = req.user.match(/evidence_id="([^"]+)"/)![1];
    return { injection_suspected: false, results: keys.map((k) => ({ criterion_key: k, result: "pass", confidence: 0.9, rationale: "Stated.",
      quotes: [{ evidence_id: id, text: "We buy ACA and final expense leads from publishers" }] })) };
  },
  "q1.summary": () => ({ why_fit: ["Buys ACA leads"], risks: [] }),
  "w1.compose": () => ({ subject: "ACA data leads", body: "Hi Ann,\n\nYou buy ACA leads from publishers.\n\nOpen to a 50-lead test this month?", ai_spans: [],
    personalization_basis: ["buys_matching_lead_types"] }),
});

const resolveLlm = vi.fn(async (_tenantId: string) => llm);

beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'h', 'h@a.vn', 'head_of_bd')", [userId, t.tenantA]);
  await t.admin.query(`INSERT INTO abcrm.data_providers(id, key, kind, priority, license, status)
    VALUES ($1, 'fixture', 'contact_finder', 1, '{"resale_ok": true, "cache_scope": "none"}', 'active')`, [randomUUID()]);
  const provider = new StaticContactProvider("fixture", {
    "buyer.com": [{ firstName: "Ann", lastName: "Lee", title: "Affiliate Manager", email: "ann@buyer.com" },
      { firstName: "Bo", lastName: "Kim", title: "Director of Partnerships", email: "bo@buyer.com" }],
  });
  registerQualification({ pool: t.app, llm: null, resolveLlm, contacts: { pool: t.app, global: t.global, keyring, platform: new PlatformKeys(generateKey(), generateKey()), providers: [provider] } });
  await launchEngine(t.adminUrl);
  const ids = await withTenant(t.app, t.tenantA, actor, async (tx) => {
    const { playbook, ipp } = await cloneFromPack(tx, actor, "insurance", "ACA & FE data-lead buyers");
    return { playbook: playbook.id, ipp: ipp.id };
  });
  await t.admin.query("UPDATE abcrm.playbooks SET status = 'active' WHERE id = $1", [ids.playbook]);
  await t.admin.query("UPDATE abcrm.ipps SET status = 'active' WHERE id = $1", [ids.ipp]);
  playbookId = ids.playbook;
  runId = uuidv7();
  await t.admin.query(`INSERT INTO abcrm.sourcing_runs(id, tenant_id, ipp_id, target_count, agent_credit_budget, contact_credit_budget, status)
    VALUES ($1, $2, $3, 10, 500, 10, 'running')`, [runId, t.tenantA, ids.ipp]);
});
// Workflows record their result in the system DB after the last step; wait for them before the DB goes away.
const started: string[] = [];
afterAll(async () => {
  for (const id of started) await DBOS.retrieveWorkflow(id).getResult().catch(() => undefined);
  await shutdownEngine();
  await t?.close();
});

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await dispatchOnce(t.app);
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("qualification workflows", () => {
  it("candidate.ready → Q1 scorecard → S2 contacts for a card-eligible account", async () => {
    const candidateId = await withTenant(t.app, t.tenantA, actor, async (tx) => {
      const { account } = await createAccount(tx, keyring, actor, { name: "Buyer", domain: "buyer.com" });
      await tx.client.query("UPDATE abcrm.accounts SET hq_country = 'US', employee_range = '51-200', tech_signals = '{\"trustedform\":{}}' WHERE id = $1", [account.id]);
      await tx.client.query(`INSERT INTO abcrm.evidence(id, tenant_id, account_id, kind, url, retrieved_at, snippet, content_hash)
        VALUES ($1, $2, $3, 'web_page', 'https://buyer.com/publishers', now(), 'We buy ACA and final expense leads from publishers via ping post.', $4)`,
        [uuidv7(), tx.tenantId, account.id, Buffer.from(randomUUID())]);
      const id = uuidv7();
      await tx.client.query(`INSERT INTO abcrm.candidates(id, tenant_id, sourcing_run_id, account_id, discovered_via, status) VALUES ($1, $2, $3, $4, '{"kind":"search"}', 'found')`,
        [id, tx.tenantId, runId, account.id]);
      await tx.client.query(`INSERT INTO abcrm.outbox(id, tenant_id, topic, payload) VALUES ($1, $2, 'sourcing.candidate.ready', $3)`,
        [uuidv7(), tx.tenantId, { candidate_id: id, account_id: account.id }]);
      return id;
    });

    const sc = await until(async () => (await t.admin.query("SELECT id, tier, playbook_id FROM abcrm.scorecards WHERE candidate_id = $1", [candidateId])).rows[0]);
    started.push(`q1:${candidateId}`, `s2:${sc.id}`);
    delete (sc as { id?: string }).id;
    expect(sc).toEqual({ tier: "A", playbook_id: playbookId });
    const lookup = await until(async () => (await t.admin.query(
      "SELECT status, contact_credits::float AS c, cardinality(result_contact_ids) AS n FROM abcrm.contact_lookups WHERE candidate_id = $1 AND status = 'completed'", [candidateId])).rows[0]);
    expect(lookup).toEqual({ status: "completed", c: 2, n: 2 });
    const card = await until(async () => (await t.admin.query(
      "SELECT d.gate_id, d.status FROM abcrm.decisions d JOIN abcrm.candidates c ON c.decision_id = d.id WHERE c.id = $1", [candidateId])).rows[0]);
    expect(card).toEqual({ gate_id: "G-Q", status: "pending" });
    const drafts = await t.admin.query("SELECT ed.status FROM abcrm.email_drafts ed JOIN abcrm.decisions d ON d.id = ed.decision_id JOIN abcrm.candidates c ON c.account_id = ed.account_id WHERE c.id = $1", [candidateId]);
    expect(drafts.rows).toEqual([{ status: "proposed" }]);
    expect(resolveLlm).toHaveBeenCalledWith(t.tenantA);
    expect(resolveLlm.mock.calls.length).toBeGreaterThanOrEqual(2);
    const stats = (await t.admin.query("SELECT stats FROM abcrm.sourcing_runs WHERE id = $1", [runId])).rows[0].stats;
    expect(stats).toMatchObject({ qualified: 1, contact_credits_used: 2, carded: 1 });
  });

  it("runs a requested playbook preview", async () => {
    const pv = await withTenant(t.app, t.tenantA, actor, (tx) => requestPreview(tx, actor, playbookId, { sample: "recent", size: 5 }));
    started.push(`preview:${pv.id}`);
    const done = await until(async () => (await t.admin.query("SELECT status, tier_distribution FROM abcrm.playbook_previews WHERE id = $1 AND status <> 'running'", [pv.id])).rows[0]);
    expect(done).toEqual({ status: "completed", tier_distribution: { A: 1, B: 0, C: 0, D: 0 } });
  });
});
