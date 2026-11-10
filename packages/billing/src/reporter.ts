import type { Pool } from "@abcrm/db";

export type MeterEvent = { identifier: string; customerId: string; meter: "agent" | "contact"; value: number; timestamp: Date };

/** Reports metered usage to the billing provider (pricing doc §4 step 4): quantities only, never PII. */
export interface MeterReporter {
  readonly enabled: boolean;
  report(e: MeterEvent): Promise<void>;
}

/** Disabled adapter: hours are aggregated and marked `skipped` so nothing is lost; turn on by setting STRIPE_SECRET_KEY. */
export class DisabledReporter implements MeterReporter {
  readonly enabled = false;
  async report(): Promise<void> { /* no-op */ }
}

/** Stripe Billing Meters (`/v1/billing/meter_events`). The identifier makes retries idempotent on Stripe's side. */
export class StripeMeterReporter implements MeterReporter {
  readonly enabled = true;
  constructor(private readonly secretKey: string, private readonly eventNames = { agent: "abcrm_agent_credits", contact: "abcrm_contact_credits" },
    private readonly fetchImpl: typeof fetch = fetch) {}
  async report(e: MeterEvent): Promise<void> {
    const body = new URLSearchParams({
      event_name: this.eventNames[e.meter], identifier: e.identifier, timestamp: String(Math.floor(e.timestamp.getTime() / 1000)),
      "payload[stripe_customer_id]": e.customerId, "payload[value]": String(e.value),
    });
    const res = await this.fetchImpl("https://api.stripe.com/v1/billing/meter_events", {
      method: "POST", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" }, body,
    });
    if (!res.ok) throw new Error(`stripe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export function reporterFromEnv(env = process.env): MeterReporter {
  return env.STRIPE_SECRET_KEY ? new StripeMeterReporter(env.STRIPE_SECRET_KEY) : new DisabledReporter();
}

/**
 * Hourly job: aggregates completed hours of billable usage per tenant and meter (claim_usage_reports) and reports
 * them. Tenants without a Stripe customer, or a disabled reporter, are marked `skipped`; errors are `failed` and retried.
 */
export async function reportUsage(pool: Pool, reporter: MeterReporter, since: Date): Promise<{ reported: number; skipped: number; failed: number }> {
  const { rows } = await pool.query<{ identifier: string; tenant_id: string; stripe_customer_id: string | null; meter: "agent" | "contact"; hour: Date; credits: string }>(
    "SELECT * FROM abcrm.claim_usage_reports($1)", [since]);
  const out = { reported: 0, skipped: 0, failed: 0 };
  for (const r of rows) {
    if (!reporter.enabled || !r.stripe_customer_id) {
      await pool.query("SELECT abcrm.mark_usage_report($1, 'skipped', $2)", [r.identifier, reporter.enabled ? "no stripe customer" : "reporter disabled"]);
      out.skipped++;
      continue;
    }
    try {
      await reporter.report({ identifier: r.identifier, customerId: r.stripe_customer_id, meter: r.meter, value: Number(r.credits), timestamp: r.hour });
      await pool.query("SELECT abcrm.mark_usage_report($1, 'reported')", [r.identifier]);
      out.reported++;
    } catch (e) {
      await pool.query("SELECT abcrm.mark_usage_report($1, 'failed', $2)", [r.identifier, (e as Error).message.slice(0, 300)]);
      out.failed++;
    }
  }
  return out;
}
