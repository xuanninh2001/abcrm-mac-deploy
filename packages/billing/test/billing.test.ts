import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@abcrm/core";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { DisabledReporter, reportUsage, StripeMeterReporter, type MeterEvent, type MeterReporter } from "../src/index.js";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("UPDATE abcrm.tenants SET stripe_customer_id = 'cus_A' WHERE id = $1", [t.tenantA]);
  const ins = `INSERT INTO abcrm.usage_events(id, tenant_id, idempotency_key, occurred_at, meter, action_type, credits, billable)
               VALUES ($1, $2, $3, date_trunc('hour', now()) - interval '30 minutes', $4, 'x', $5, $6)`;
  for (const [tenant, meter, credits, billable] of [[t.tenantA, "agent", 4, true], [t.tenantA, "agent", 2, true], [t.tenantA, "contact", 1, true],
    [t.tenantA, "agent", 50, false], [t.tenantB, "agent", 3, true]] as const) {
    await t.admin.query(ins, [uuidv7(), tenant, randomUUID(), meter, credits, billable]);
  }
  // Current (incomplete) hour is never reported.
  await t.admin.query(`INSERT INTO abcrm.usage_events(id, tenant_id, idempotency_key, occurred_at, meter, action_type, credits) VALUES ($1, $2, $3, now(), 'agent', 'x', 9)`,
    [uuidv7(), t.tenantA, randomUUID()]);
});
afterAll(async () => { await t?.close(); });

describe("usage reporting", () => {
  it("aggregates completed hours per tenant and meter, reports once, skips tenants without a customer", async () => {
    const sent: MeterEvent[] = [];
    const fake: MeterReporter = { enabled: true, report: async (e) => { sent.push(e); } };
    const since = new Date(Date.now() - 3 * 3600_000);
    expect(await reportUsage(t.app, fake, since)).toEqual({ reported: 2, skipped: 1, failed: 0 });
    expect(sent.map((e) => [e.customerId, e.meter, e.value]).sort()).toEqual([["cus_A", "agent", 6], ["cus_A", "contact", 1]]);
    expect(await reportUsage(t.app, fake, since)).toEqual({ reported: 0, skipped: 0, failed: 0 });
    const rows = await t.admin.query("SELECT status, error FROM abcrm.usage_reports WHERE tenant_id = $1", [t.tenantB]);
    expect(rows.rows).toEqual([{ status: "skipped", error: "no stripe customer" }]);
  });

  it("failed reports are retried; the disabled reporter skips without calling out", async () => {
    await t.admin.query("DELETE FROM abcrm.usage_reports");
    const flaky: MeterReporter = { enabled: true, report: async () => { throw new Error("stripe 500"); } };
    const since = new Date(Date.now() - 3 * 3600_000);
    expect(await reportUsage(t.app, flaky, since)).toMatchObject({ failed: 2 });
    expect(await reportUsage(t.app, new DisabledReporter(), since)).toEqual({ reported: 0, skipped: 2, failed: 0 });
  });

  it("Stripe adapter posts a form-encoded meter event with an idempotent identifier", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const r = new StripeMeterReporter("sk_test", undefined, (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); }) as typeof fetch);
    await r.report({ identifier: "t:agent:2026102601", customerId: "cus_A", meter: "agent", value: 6, timestamp: new Date("2026-10-26T01:00:00Z") });
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/billing/meter_events");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(body)).toEqual({ event_name: "abcrm_agent_credits", identifier: "t:agent:2026102601", timestamp: "1792976400",
      "payload[stripe_customer_id]": "cus_A", "payload[value]": "6" });
  });
});
