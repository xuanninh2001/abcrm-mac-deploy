import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { cloneFromPack, listPacks, loadPack } from "@abcrm/setup";
import { createAccount, setAccountFlags } from "@abcrm/crm";
import { createRun, estimateRun, Fetcher, listCandidates, listEvidence, planQueries, runSourcing, sentencesWith, StaticSearch, TECH_SIGNATURES, type Step } from "../src/index.js";

let t: TestDb;
let server: Server;
let base: string;
let fetcher: Fetcher;
let ippId: string;
const keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));
const userId = randomUUID();
const actor = { type: "user", id: userId } as const;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, actor, fn);

const BUYER = (n: string, extra = "") => `<html><head><title>${n} | Insurance Leads</title>
  <script src="https://api.trustedform.com/trustedform.js"></script></head><body>
  <h1>${n}</h1><p>We buy ACA leads and Final Expense leads from publishers.</p><p>Become a lead vendor today.</p>${extra}
  <a href="publishers">Publishers</a></body></html>`;
const SITES: Record<string, string> = {
  "buyer1.com": BUYER("Buyer One"), "buyer2.com": BUYER("Buyer Two"), "buyer3.com": BUYER("Buyer Three"),
  "buyer4.com": BUYER("Buyer Four"), "buyer5.com": BUYER("Buyer Five"), "existing.com": BUYER("Existing Partner"),
  "rival.com": "<html><head><title>Rival Leads</title></head><body><p>We sell leads to insurance agents. Buy leads from us.</p></body></html>",
  "bakery.com": "<html><head><title>Bakery</title></head><body><p>Fresh bread every morning, delivered to your door.</p></body></html>",
};
const DOMAINS = ["linkedin.com", "rival.com", "buyer1.com", "bakery.com", "existing.com", "buyer2.com", "unreachable.com", "buyer3.com", "buyer4.com", "buyer5.com"];

beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'h', 'h@a.vn', 'head_of_bd')", [userId, t.tenantA]);
  server = createServer((req, res) => {
    const [, domain, rest] = (req.url ?? "/").match(/^\/([^/]+)\/?(.*)$/) ?? [];
    if (req.url === "/robots.txt") { res.writeHead(404).end(); return; }
    const site = domain ? SITES[domain] : undefined;
    if (!site) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html" }).end(rest === "publishers" ? "<p>Posting specs: TrustedForm required on every lead.</p>" : site);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fetcher = new Fetcher(t.global, { userAgent: "ABCRMBot/test", allowPrivate: true, minIntervalMs: 0 });
  const { playbook, ipp } = await inA((tx) => cloneFromPack(tx, actor, "insurance", "ACA & FE data-lead buyers"));
  await t.admin.query("UPDATE abcrm.playbooks SET status = 'active' WHERE id = $1", [playbook.id]);
  await t.admin.query("UPDATE abcrm.ipps SET status = 'active' WHERE id = $1", [ipp.id]);
  ippId = ipp.id;
  const { account } = await inA((tx) => createAccount(tx, keyring, actor, { name: "Existing", domain: "existing.com" }));
  await inA((tx) => setAccountFlags(tx, actor, account.id, ["existing_buyer"], []));
});
afterAll(async () => { await fetcher?.close(); server?.close(); await t?.close(); });
beforeEach(async () => { await t.admin.query("DELETE FROM abcrm.domain_fetch_state"); });

const search = () => new StaticSearch({}, DOMAINS.map((d) => ({ url: `https://www.${d}/some/page`, title: d, snippet: "" })));
const deps = (extra: Partial<Parameters<typeof runSourcing>[0]> = {}) =>
  ({ pool: t.app, keyring, fetcher, search: search(), siteUrl: (d: string) => `${base}/${d}/`, ...extra });
const newRun = (targetCount: number, agentCreditBudget = 1000) =>
  inA((tx) => createRun(tx, actor, { ippId, targetCount, agentCreditBudget, contactCreditBudget: 100 }));

describe("planning & helpers", () => {
  it("every pack's tech signals have a detector, and every pack plans queries per lead type", async () => {
    for (const key of await listPacks()) {
      const pack = await loadPack(key);
      expect(pack.signals.tech.filter((t) => !TECH_SIGNATURES[t]), key).toEqual([]);
      const queries = planQueries({ lead_types: [pack.taxonomy.lead_types[0]!.key], signals: { text: [] } }, pack);
      expect(queries.length, key).toBe(pack.query_templates.length);
      expect(queries.every((q) => q.includes(pack.taxonomy.lead_types[0]!.label)), key).toBe(true);
    }
  });

  it("plans queries from IPP lead types and pack templates", async () => {
    const pack = await loadPack("insurance");
    const q = planQueries({ lead_types: ["aca_health", "final_expense"], signals: { text: ["lead vendor"] } }, pack);
    expect(q).toContain('"ACA / Health leads" "publishers"');
    expect(q).toContain('"Final Expense" "lead vendors" "posting specs"');
    expect(q.length).toBeLessThanOrEqual(30);
  });

  it("extracts verbatim sentences containing phrases", () => {
    const text = "Welcome.\nWe buy ACA leads from publishers via ping post.\nContact us.";
    expect(sentencesWith(text, ["ping post"])).toEqual(["We buy ACA leads from publishers via ping post."]);
  });

  it("estimates credits and flags large runs for approval", () => {
    expect(estimateRun(200)).toMatchObject({ agent_credits: 400, requires_approval: false });
    expect(estimateRun(600).requires_approval).toBe(true);
  });
});

describe("sourcing run", () => {
  it("finds buyers, skips noise/competitors, dedupes existing buyers, stores verbatim evidence, meters credits", async () => {
    const run = await newRun(3);
    expect(run.status).toBe("queued");
    const res = await runSourcing(deps(), t.tenantA, run.id);
    expect(res.status).toBe("completed");
    expect(res.stats).toMatchObject({ found: 3, deduped: 1, agent_credits_used: 6 });
    expect(res.stats.skipped).toBeGreaterThanOrEqual(3);   // rival (competitor), bakery (no signal), unreachable

    const candidates = await inA((tx) => listCandidates(tx, run.id, { limit: 50 }));
    expect(candidates.filter((c) => c.status === "found").map((c) => c.domain)).toEqual(["buyer1.com", "buyer2.com", "buyer3.com"]);
    expect(candidates.find((c) => c.domain === "existing.com")).toMatchObject({ status: "deduped", dedupe_reason: "existing_buyer" });
    expect(candidates.map((c) => c.domain)).not.toContain("linkedin.com");
    expect(candidates.map((c) => c.domain)).not.toContain("rival.com");

    const buyer1 = candidates.find((c) => c.domain === "buyer1.com")!;
    expect(buyer1.tech_signals).toHaveProperty("trustedform");
    expect(buyer1.lead_types).toEqual(expect.arrayContaining(["aca_health", "final_expense"]));
    const evidence = await inA((tx) => listEvidence(tx, buyer1.account_id));
    const page = await t.admin.query("SELECT content_text FROM abcrm.public_pages WHERE url = $1", [`${base}/buyer1.com/`]);
    for (const e of evidence.filter((x) => x.kind === "web_page")) {
      expect(page.rows[0].content_text + "Posting specs: TrustedForm required on every lead.").toContain(e.snippet);
    }
    expect(evidence.some((e) => e.kind === "tech_signal")).toBe(true);

    const usage = await t.admin.query("SELECT count(*)::int AS n, sum(credits)::int AS c FROM abcrm.usage_events WHERE sourcing_run_id = $1", [run.id]);
    expect(usage.rows[0]).toEqual({ n: 3, c: 6 });
    const events = await t.admin.query("SELECT count(*)::int AS n FROM abcrm.outbox WHERE topic = 'sourcing.candidate.ready' AND correlation_id = $1", [run.id]);
    expect(events.rows[0].n).toBe(3);
  });

  it("stops at the credit budget", async () => {
    const run = await newRun(10, 4);
    const res = await runSourcing(deps(), t.tenantA, run.id);
    expect(res).toMatchObject({ status: "budget_exhausted", stats: { found: 2, agent_credits_used: 4 } });
  });

  it("does nothing for paused or finished runs", async () => {
    const run = await newRun(1);
    await t.admin.query("UPDATE abcrm.sourcing_runs SET status = 'paused' WHERE id = $1", [run.id]);
    expect((await runSourcing(deps(), t.tenantA, run.id)).status).toBe("paused");
  });

  it("resumes after a crash from checkpoints without duplicate candidates or charges", async () => {
    const run = await newRun(4);
    const memo = new Map<string, unknown>();
    // Fake durable step: results are checkpointed by name, like DBOS.runStep.
    const durable: Step = async (name, fn) => {
      if (memo.has(name)) return memo.get(name) as never;
      const v = await fn();
      memo.set(name, v);
      return v;
    };
    let examined = 0;
    const flaky: Step = async (name, fn) => {
      if (name.startsWith("examine:") && !memo.has(name) && ++examined === 4) throw new Error("worker crashed");
      return durable(name, fn);
    };
    await expect(runSourcing(deps({ step: flaky }), t.tenantA, run.id)).rejects.toThrow("worker crashed");
    const res = await runSourcing(deps({ step: durable }), t.tenantA, run.id);
    expect(res.stats.found).toBe(4);
    const usage = await t.admin.query("SELECT count(*)::int AS n FROM abcrm.usage_events WHERE sourcing_run_id = $1", [run.id]);
    expect(usage.rows[0].n).toBe(4);
    const cands = await t.admin.query("SELECT count(*)::int AS n FROM abcrm.candidates WHERE sourcing_run_id = $1 AND status = 'found'", [run.id]);
    expect(cands.rows[0].n).toBe(4);
  });

  it("runs need an active IPP; candidates are tenant-scoped", async () => {
    const run = await newRun(1);
    await expect(withTenant(t.app, t.tenantB, actor, (tx) => listCandidates(tx, run.id, { limit: 5 }))).rejects.toThrow(/not found/);
    await t.admin.query("UPDATE abcrm.ipps SET status = 'archived' WHERE id = $1", [ippId]);
    await expect(newRun(1)).rejects.toThrow(/active IPP/);
    await t.admin.query("UPDATE abcrm.ipps SET status = 'active' WHERE id = $1", [ippId]);
  });
});

describe("tenant guardrails", () => {
  it("a paused S1 agent pauses the run; exhausted tenant credits stop it", async () => {
    const run = await newRun(1);
    await inA(async (tx) => {
      await tx.client.query("UPDATE abcrm.agent_definitions SET status = 'paused', paused_reason = 'manual' WHERE template_key = 'S1'");
    });
    expect((await runSourcing(deps(), t.tenantA, run.id)).status).toBe("paused");
    expect((await t.admin.query("SELECT stats->>'paused_reason' AS r FROM abcrm.sourcing_runs WHERE id = $1", [run.id])).rows[0].r).toBe("agent_paused");
    await t.admin.query("UPDATE abcrm.agent_definitions SET status = 'active', paused_reason = NULL WHERE template_key = 'S1'");

    const run2 = await newRun(5);
    await t.admin.query("UPDATE abcrm.usage_balances SET used = included WHERE tenant_id = $1 AND meter = 'agent'", [t.tenantA]);
    const res = await runSourcing(deps(), t.tenantA, run2.id);
    expect(res.status).toBe("budget_exhausted");
    expect((await t.admin.query("SELECT stats->>'error' AS e FROM abcrm.sourcing_runs WHERE id = $1", [run2.id])).rows[0].e).toBe("tenant agent credits exhausted");
    await t.admin.query("UPDATE abcrm.usage_balances SET used = 0 WHERE tenant_id = $1", [t.tenantA]);
  });
});
