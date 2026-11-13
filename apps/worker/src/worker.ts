import { TenantKeyring } from "@abcrm/core";
import { keyProviderFromEnv } from "@abcrm/crypto";
import { createPool, withTenant } from "@abcrm/db";
import { BraveSearch, CachedSearch, Fetcher, fetcherPageSource } from "@abcrm/sourcing";
import { PlatformKeys } from "@abcrm/contactdata";
import { llmFromEnv, tenantLlm } from "@abcrm/llm";
import { launchEngine, shutdownEngine } from "./engine.js";
import { startDispatcher } from "./dispatcher.js";
import { registerDecisionWait } from "./workflows/decision-wait.js";
import { registerSourcing } from "./workflows/sourcing.js";
import { registerQualification } from "./workflows/qualification.js";
import { registerNotifications } from "./workflows/notifications.js";
import { registerPlanQueues } from "./queues.js";
import { maintenanceOnce } from "./maintenance.js";
import { mailerFromEnv } from "@abcrm/notify";
import { reporterFromEnv } from "@abcrm/billing";

const appUrl = process.env.APP_DATABASE_URL;
const systemUrl = process.env.DBOS_SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
if (!appUrl || !systemUrl) throw new Error("APP_DATABASE_URL and DBOS_SYSTEM_DATABASE_URL (or DATABASE_URL) are required");

const globalUrl = process.env.GLOBAL_DATABASE_URL;
if (!globalUrl) throw new Error("GLOBAL_DATABASE_URL (abcrm_global member) is required");

const pool = createPool(appUrl);
const globalPool = createPool(globalUrl);
const fetcher = new Fetcher(globalPool, {
  userAgent: process.env.ABCRM_BOT_UA ?? "ABCRMBot/0.1 (+https://abcrm.app/bot)",
  minIntervalMs: Number(process.env.ABCRM_FETCH_INTERVAL_MS ?? 2000),
});
const braveKey = process.env.BRAVE_SEARCH_API_KEY;
if (!braveKey) console.warn("BRAVE_SEARCH_API_KEY not set: sourcing runs will fail with 'search provider not configured'");

const llm = llmFromEnv();
if (!llm) console.warn("Environment Claude credentials absent; workspace LLM settings will be checked for each workflow.");
const keyring = new TenantKeyring(keyProviderFromEnv());
const resolveLlm = (tenantId: string) => withTenant(pool, tenantId, { type: "system", id: "llm-settings" }, tx => tenantLlm(tx, keyring));

// Workflows and event handlers must be registered before launch so DBOS can recover them.
registerDecisionWait(pool);
registerSourcing({
  pool, fetcher, keyring, llm, resolveLlm,
  search: braveKey ? new CachedSearch(new BraveSearch(braveKey), globalPool) : null,
});
// Contact data vendors are added here as their contracts are signed (ADR-015); none ship by default.
registerQualification({
  pool, llm, resolveLlm, pages: fetcherPageSource(fetcher),
  contacts: { pool, global: globalPool, keyring, platform: PlatformKeys.fromEnv(), providers: [] },
});
const mailer = mailerFromEnv();
if (!mailer.enabled) console.warn("POSTMARK_SERVER_TOKEN/NOTIFY_FROM_EMAIL not set: notifications stay in-app (email skipped)");
const reporter = reporterFromEnv();
if (!reporter.enabled) console.warn("STRIPE_SECRET_KEY not set: usage is aggregated hourly but not reported to Stripe");
registerNotifications(pool, mailer);
await launchEngine(systemUrl);
await registerPlanQueues(pool);
const stop = startDispatcher(pool);
// Periodic jobs: card expiry, stale reservations, SLA escalation, digests, hourly usage reporting.
const expiry = setInterval(() => { void maintenanceOnce({ pool, reporter }); }, 60_000);
console.log("abcrm worker started");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stop();
    clearInterval(expiry);
    await shutdownEngine();
    await fetcher.close();
    await globalPool.end();
    await pool.end();
    process.exit(0);
  });
}
