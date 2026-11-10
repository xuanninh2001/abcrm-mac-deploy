import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { allows, assertCanSpend, canSpend, getBalances, recordUsage, releaseReservation, reserveCredits, updateUsageSettings, usageSummary, uuidFromName, type Balance } from "../src/index.js";

const sys = { type: "system", id: "test" } as const;
let t: TestDb;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, sys, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantB, sys, fn);
const use = (tx: TenantTx, credits: number, extra: Partial<Parameters<typeof recordUsage>[1]> = {}) =>
  recordUsage(tx, { idempotencyKey: randomUUID(), meter: "agent", actionType: "test", credits, ...extra });
const topics = async (tx: TenantTx, topic: string) => (await tx.client.query("SELECT payload FROM abcrm.outbox WHERE topic = $1 ORDER BY created_at", [topic])).rows.map((r) => r.payload);

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t?.close(); });

describe("balances", () => {
  const b = (o: Partial<Balance>): Balance => ({ meter: "agent", period: "2026-10-01", included: 100, used: 0, reserved: 0, overage_enabled: false, spend_cap_usd: null,
    overage_unit_price_usd: 0.01, hard_stop: true, ...o });
  it("allows within included, within the spend cap with overage, never past a hard stop", () => {
    expect(allows(b({ used: 99 }), 1)).toBe(true);
    expect(allows(b({ used: 99 }), 2)).toBe(false);
    expect(allows(b({ used: 99, overage_enabled: true, hard_stop: false, spend_cap_usd: 1 }), 101)).toBe(true);   // 100 over × $0.01 = $1
    expect(allows(b({ used: 99, overage_enabled: true, hard_stop: false, spend_cap_usd: 1 }), 102)).toBe(false);
    expect(allows(b({ used: 1e6, overage_enabled: true, hard_stop: false, spend_cap_usd: null }), 5)).toBe(true);
  });

  it("charges usage once per key, emits thresholds and enforces the trial hard stop", async () => {
    await inA(async (tx) => {
      expect((await getBalances(tx)).map((x) => [x.meter, x.included, x.used, x.hard_stop])).toEqual([["agent", 1000, 0, true], ["contact", 50, 0, true]]);
      const key = randomUUID();
      expect(await recordUsage(tx, { idempotencyKey: key, meter: "agent", actionType: "x", credits: 600 })).toBe(true);
      expect(await recordUsage(tx, { idempotencyKey: key, meter: "agent", actionType: "x", credits: 600 })).toBe(false);
      expect((await topics(tx, "billing.balance.threshold_crossed")).map((p) => p.pct)).toEqual([50]);
      await use(tx, 390);
      expect((await topics(tx, "billing.balance.threshold_crossed")).map((p) => p.pct)).toEqual([50, 80]);
      expect(await canSpend(tx, "agent", 10)).toBe(true);
      expect(await canSpend(tx, "agent", 11)).toBe(false);
      await use(tx, 10);
      expect((await topics(tx, "billing.balance.exhausted")).length).toBe(1);
      await expect(assertCanSpend(tx, "agent", 1)).rejects.toMatchObject({ status: 402, extra: { meter: "agent" } });
      // Non-billable events (compliance, internal retries) do not touch the balance.
      await use(tx, 50, { billable: false });
      expect((await getBalances(tx)).find((x) => x.meter === "agent")!.used).toBe(1000);
    });
    // Tenant B has its own balance.
    expect(await inB((tx) => canSpend(tx, "agent", 500))).toBe(true);
  });

  it("owner can turn on overage with a spend cap", async () => {
    await inA(async (tx) => {
      await updateUsageSettings(tx, { meter: "agent", overageEnabled: true, spendCapUsd: 0.12 });   // 10 credits at $0.012
      expect(await canSpend(tx, "agent", 10)).toBe(true);
      expect(await canSpend(tx, "agent", 11)).toBe(false);
      const s = await usageSummary(tx);
      expect(s.by_action.find((r: { action_type: string }) => r.action_type === "test").credits).toBe(400);
    });
  });
});

describe("reservations", () => {
  it("reserve → commit charges the actual amount; release frees it; concurrent reservations cannot pass the cap", async () => {
    await inB(async (tx) => {
      const before = (await getBalances(tx)).find((x) => x.meter === "contact")!;
      expect(await reserveCredits(tx, "contact", 5, "lk1")).toBe(true);
      expect(await reserveCredits(tx, "contact", 5, "lk1")).toBe(true);   // idempotent
      expect((await getBalances(tx)).find((x) => x.meter === "contact")).toMatchObject({ reserved: 5, used: before.used });
      await recordUsage(tx, { idempotencyKey: "lk1:c1", meter: "contact", actionType: "contact_valid", credits: 2, reservationKey: "lk1" });
      expect((await getBalances(tx)).find((x) => x.meter === "contact")).toMatchObject({ reserved: 0, used: before.used + 2 });
      expect(await reserveCredits(tx, "contact", 3, "lk2")).toBe(true);
      await releaseReservation(tx, "lk2");
      await releaseReservation(tx, "lk2");
      expect((await getBalances(tx)).find((x) => x.meter === "contact")).toMatchObject({ reserved: 0 });
      expect(await reserveCredits(tx, "contact", 3, "lk2")).toBe(false);   // released keys are spent
    });
    // Two transactions racing for the last 30 contact credits: only one wins.
    const left = await inB(async (tx) => { const c = (await getBalances(tx)).find((x) => x.meter === "contact")!; return c.included - c.used; });
    const results = await Promise.all([1, 2].map((i) => inB((tx) => reserveCredits(tx, "contact", left - 1, `race${i}`))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("stale reservations are released by the sweep", async () => {
    await inB((tx) => reserveCredits(tx, "agent", 7, "stale"));
    await t.admin.query("UPDATE abcrm.usage_reservations SET created_at = now() - interval '2 hours' WHERE key = 'stale'");
    const { rows: [r] } = await t.app.query("SELECT abcrm.release_stale_reservations('1 hour') AS n");
    expect(r.n).toBeGreaterThanOrEqual(1);
    expect(await inB(async (tx) => (await getBalances(tx)).find((x) => x.meter === "agent")!.reserved)).toBe(0);
  });
});

describe("agent guardrails", () => {
  async function agent(tx: TenantTx, budget: { daily?: number; monthly?: number } = {}) {
    const id = randomUUID();
    await tx.client.query(
      `INSERT INTO abcrm.agent_definitions(id, tenant_id, lineage_id, template_key, template_version, name, version, config, run_as, status, credit_budget_daily, credit_budget_monthly)
       VALUES ($1, $2, $1, 'Q1', 1, 'Q', 1, '{}', '{"type":"persona","id":"x"}', 'active', $3, $4)`, [id, tx.tenantId, budget.daily ?? null, budget.monthly ?? null]);
    return id;
  }
  const status = async (tx: TenantTx, id: string) => (await tx.client.query("SELECT status, paused_reason FROM abcrm.agent_definitions WHERE id = $1", [id])).rows[0];

  it("pauses an agent at its daily budget", async () => {
    await inB(async (tx) => {
      const id = await agent(tx, { daily: 10 });
      await use(tx, 6, { agentDefinitionId: id });
      expect(await status(tx, id)).toEqual({ status: "active", paused_reason: null });
      await use(tx, 4, { agentDefinitionId: id });
      expect(await status(tx, id)).toEqual({ status: "paused", paused_reason: "budget" });
      expect((await topics(tx, "agents.agent.paused")).at(-1)).toEqual({ agent_definition_id: id, reason: "budget" });
    });
  });

  it("alerts at 3× and pauses at 5× the 7-day average", async () => {
    await inB(async (tx) => {
      const id = await agent(tx);
      for (let d = 1; d <= 7; d++) {
        await tx.client.query("INSERT INTO abcrm.agent_usage_daily(tenant_id, agent_definition_id, date, credits) VALUES ($1, $2, current_date - $3::int, 20)", [tx.tenantId, id, d]);
      }
      await use(tx, 61, { agentDefinitionId: id });
      expect((await topics(tx, "agents.agent.anomaly_detected")).map((p) => p.agent_definition_id)).toEqual([id]);
      expect((await status(tx, id)).status).toBe("active");
      await use(tx, 40, { agentDefinitionId: id });
      expect(await status(tx, id)).toEqual({ status: "paused", paused_reason: "anomaly" });
    });
  });
});

describe("uuidFromName", () => {
  it("is deterministic and a valid v8 uuid", () => {
    expect(uuidFromName("a")).toBe(uuidFromName("a"));
    expect(uuidFromName("a")).not.toBe(uuidFromName("b"));
    expect(uuidFromName("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
