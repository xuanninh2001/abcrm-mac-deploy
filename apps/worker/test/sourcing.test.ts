import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { withTenant } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { cloneFromPack } from "@abcrm/setup";
import { createRun, Fetcher, StaticSearch, type SearchProvider } from "@abcrm/sourcing";
import { launchEngine, shutdownEngine } from "../src/engine.js";
import { dispatchOnce } from "../src/dispatcher.js";
import { registerSourcing } from "../src/workflows/sourcing.js";

const resolveLlm = vi.fn(async (_tenantId: string) => null);
let t: TestDb;
let server: Server;
let base: string;
let fetcher: Fetcher;
let ippId: string;
const userId = randomUUID();
const actor = { type: "user", id: userId } as const;
// Mutable so one registered workflow can be exercised with and without a provider.
const provider: { current: SearchProvider | null } = { current: null };

beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'h', 'h@a.vn', 'head_of_bd')", [userId, t.tenantA]);
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(404).end(); return; }
    const domain = (req.url ?? "/").split("/")[1] ?? "";
    if (!domain.startsWith("buyer")) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html" }).end(`<title>${domain}</title><p>We buy ACA leads from publishers. Become a lead vendor.</p>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fetcher = new Fetcher(t.global, { userAgent: "ABCRMBot/test", allowPrivate: true, minIntervalMs: 0 });
  const search: SearchProvider = { name: "proxy", search: (q) => provider.current!.search(q) };
  registerSourcing({ pool: t.app, fetcher, resolveLlm, keyring: new TenantKeyring(new LocalKeyProvider(generateKey())), siteUrl: (d: string) => `${base}/${d}/`,
    get search() { return provider.current ? search : null; } } as never);
  await launchEngine(t.adminUrl);
  const { playbook, ipp } = await withTenant(t.app, t.tenantA, actor, (tx) => cloneFromPack(tx, actor, "insurance", "ACA & FE data-lead buyers"));
  await t.admin.query("UPDATE abcrm.playbooks SET status = 'active' WHERE id = $1", [playbook.id]);
  await t.admin.query("UPDATE abcrm.ipps SET status = 'active' WHERE id = $1", [ipp.id]);
  ippId = ipp.id;
});
afterAll(async () => { await shutdownEngine(); await fetcher?.close(); server?.close(); await t?.close(); });

async function waitForStatus(runId: string, done: string[], timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await dispatchOnce(t.app);
    const { rows: [r] } = await t.admin.query("SELECT status, stats FROM abcrm.sourcing_runs WHERE id = $1", [runId]);
    if (done.includes(r.status)) return r;
    if (Date.now() > until) throw new Error(`run stuck in ${r.status}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

describe("sourcing workflow", () => {
  it("a queued run is picked up from the outbox and completes durably", async () => {
    provider.current = new StaticSearch({}, ["buyer-a.com", "buyer-b.com", "nothing.com"].map((d) => ({ url: `https://${d}/`, title: d, snippet: "" })));
    const run = await withTenant(t.app, t.tenantA, actor, (tx) => createRun(tx, actor, { ippId, targetCount: 2, agentCreditBudget: 100, contactCreditBudget: 10 }));
    const done = await waitForStatus(run.id, ["completed", "failed", "budget_exhausted"]);
    expect(done).toMatchObject({ status: "completed", stats: { found: 2 } });
    expect(resolveLlm).toHaveBeenCalledWith(t.tenantA);
  });

  it("fails clearly when no search provider is configured", async () => {
    provider.current = null;
    const run = await withTenant(t.app, t.tenantA, actor, (tx) => createRun(tx, actor, { ippId, targetCount: 1, agentCreditBudget: 100, contactCreditBudget: 10 }));
    const done = await waitForStatus(run.id, ["completed", "failed"]);
    expect(done).toMatchObject({ status: "failed", stats: { error: "search provider not configured" } });
  });
});
