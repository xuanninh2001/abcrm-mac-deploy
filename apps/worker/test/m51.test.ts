import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { uuidv7 } from "@abcrm/core";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { DisabledMailer } from "@abcrm/notify";
import { DisabledReporter } from "@abcrm/billing";
import { launchEngine, shutdownEngine } from "../src/engine.js";
import { dispatchOnce } from "../src/dispatcher.js";
import { registerPlanQueues } from "../src/queues.js";
import { registerNotifications } from "../src/workflows/notifications.js";
import { maintenanceOnce } from "../src/maintenance.js";

let t: TestDb;
const owner = randomUUID(), rep = randomUUID(), digestUser = randomUUID();
const mailer = new DisabledMailer();

// Concurrency probe: records how many runs of a tenant overlap.
const running: Record<string, number> = {};
const peak: Record<string, number> = {};
let peakTotal = 0;
async function probe(tenant: string) {
  running[tenant] = (running[tenant] ?? 0) + 1;
  peak[tenant] = Math.max(peak[tenant] ?? 0, running[tenant]!);
  peakTotal = Math.max(peakTotal, Object.values(running).reduce((a, b) => a + b, 0));
  await DBOS.sleep(400);
  running[tenant]!--;
}
const probeWf = DBOS.registerWorkflow(probe, { name: "probe" });

beforeAll(async () => {
  t = await setupTestDb();
  const off = (() => { let o = (8 - new Date().getUTCHours() + 24) % 24; if (o > 14) o -= 24; return o; })();
  const zone = off >= 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;   // a zone where it is 08:xx now
  const ins = "INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role, timezone) VALUES ($1, $2, $3, $4, $5, $6)";
  await t.admin.query(ins, [owner, t.tenantA, "o", "owner@a.vn", "owner", "Asia/Ho_Chi_Minh"]);
  await t.admin.query(ins, [rep, t.tenantA, "r", "rep@a.vn", "sales_rep", "Asia/Ho_Chi_Minh"]);
  await t.admin.query(ins, [digestUser, t.tenantB, "d", "rep@b.ph", "sales_rep", zone]);
  registerNotifications(t.app, mailer);
  await launchEngine(t.adminUrl);
  expect(await registerPlanQueues(t.app)).toContain("agents-trial");
});
afterAll(async () => { await shutdownEngine(); await t?.close(); });

async function drain(until: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await until())) {
    await dispatchOnce(t.app);
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("plan concurrency", () => {
  it("limits running agent workflows per tenant to the plan's max_concurrency, not across tenants", async () => {
    const opts = (tenant: string) => ({ queueName: "agents-trial", enqueueOptions: { queuePartitionKey: tenant } });
    const handles = [];
    for (let i = 0; i < 4; i++) handles.push(await DBOS.startWorkflow(probeWf, opts(t.tenantA))(t.tenantA));
    for (let i = 0; i < 2; i++) handles.push(await DBOS.startWorkflow(probeWf, opts(t.tenantB))(t.tenantB));
    for (const h of handles) await h.getResult();
    expect(peak[t.tenantA]).toBe(2);   // trial max_concurrency = 2
    expect(peak[t.tenantB]).toBeLessThanOrEqual(2);
    expect(peakTotal).toBeGreaterThan(2);
  }, 30_000);
});

describe("billing alerts and email", () => {
  it("80% usage notifies owners/admins in-app; email goes through the (disabled) mailer", async () => {
    await t.admin.query("INSERT INTO abcrm.outbox(id, tenant_id, topic, payload) VALUES ($1, $2, 'billing.balance.threshold_crossed', $3)",
      [uuidv7(), t.tenantA, { meter: "agent", pct: 80 }]);
    await drain(async () => (await t.admin.query("SELECT 1 FROM abcrm.notifications WHERE user_id = $1 AND email_status <> 'pending'", [owner])).rowCount! > 0);
    const n = await t.admin.query("SELECT kind, title, email_status FROM abcrm.notifications WHERE tenant_id = $1", [t.tenantA]);
    expect(n.rows).toEqual([{ kind: "billing_threshold", title: "Agent credits 80% used", email_status: "skipped" }]);
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@a.vn"]);
  });
});

describe("maintenance pass", () => {
  it("escalates overdue cards, releases stale reservations, sends due digests and aggregates usage", async () => {
    const pb = uuidv7(), acc = uuidv7(), cand = uuidv7(), sc = uuidv7();
    await t.admin.query("INSERT INTO abcrm.playbooks(id, tenant_id, lineage_id, name, version, status, definition_hash) VALUES ($1, $2, $1, 'P', 1, 'active', 'h')", [pb, t.tenantB]);
    await t.admin.query("INSERT INTO abcrm.accounts(id, tenant_id, name, domain, domain_bidx) VALUES ($1, $2, 'A', 'a.com', $3)", [acc, t.tenantB, Buffer.from(randomUUID())]);
    await t.admin.query(`INSERT INTO abcrm.candidates(id, tenant_id, account_id, discovered_via, status) VALUES ($1, $2, $3, '{}', 'carded')`, [cand, t.tenantB, acc]);
    await t.admin.query(`INSERT INTO abcrm.scorecards(id, tenant_id, candidate_id, account_id, playbook_id, playbook_version, total_score, tier) VALUES ($1, $2, $3, $4, $5, 1, 90, 'A')`, [sc, t.tenantB, cand, acc, pb]);
    await t.admin.query(`INSERT INTO abcrm.decisions(id, tenant_id, gate_id, card_id, lane, subject_type, subject_id, proposed_by, action, content_hash, assignee_user_id, sla_due_at)
      VALUES ($1, $2, 'G-Q', $3, 'contact', 'account', $4, '{}', $5, '\\x00', $6, now() - interval '1 hour')`, [uuidv7(), t.tenantB, uuidv7(), acc, { tool: "account.approve_contact", args: { scorecardId: sc } }, digestUser]);
    await t.admin.query(`INSERT INTO abcrm.usage_balances(tenant_id, period, meter, included, overage_enabled, overage_unit_price_usd, hard_stop, reserved)
      VALUES ($1, date_trunc('month', now()), 'agent', 1000, false, 0.012, true, 5) ON CONFLICT (tenant_id, period, meter) DO UPDATE SET reserved = 5`, [t.tenantB]);
    await t.admin.query(`INSERT INTO abcrm.usage_reservations(tenant_id, key, period, meter, credits, created_at) VALUES ($1, 'old', date_trunc('month', now()), 'agent', 5, now() - interval '2 hours')`, [t.tenantB]);

    const r = await maintenanceOnce({ pool: t.app, reporter: new DisabledReporter() });
    expect(r).toMatchObject({ escalated: 1, released: 1, digests: 1 });
    expect(r.usage).not.toBeNull();
    const kinds = (await t.admin.query("SELECT kind FROM abcrm.notifications WHERE user_id = $1 ORDER BY kind", [digestUser])).rows.map((x) => x.kind);
    expect(kinds).toEqual(["card_overdue", "digest"]);
    const again = await maintenanceOnce({ pool: t.app, reporter: new DisabledReporter() });
    expect(again).toMatchObject({ escalated: 0, released: 0, digests: 0 });   // level 1 waits for the grace period; digest once a day
  });
});
