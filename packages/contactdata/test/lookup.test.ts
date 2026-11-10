import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { addSuppression, createAccount, createContact } from "@abcrm/crm";
import { addGlobalSuppression, findContacts, PlatformKeys, StaticContactProvider, StaticVerifier, type ContactDataDeps, type ProviderPerson } from "../src/index.js";

let t: TestDb;
const keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));
const platform = new PlatformKeys(generateKey(), generateKey());
const userId = randomUUID();
const actor = { type: "user", id: userId } as const;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, actor, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantB, actor, fn);

const P = (first: string, title: string, domain = "buyer.com"): ProviderPerson => ({ firstName: first, lastName: "Doe", title, email: `${first.toLowerCase()}@${domain}` });
const PEOPLE: Record<string, ProviderPerson[]> = {
  "buyer.com": [P("Ann", "Affiliate Manager"), P("Bob", "Software Engineer"), P("Cat", "Software Architect"), P("Dan", "Partner Marketing Specialist"), P("Eve", "Affiliate Mgr")],
  "fresh.com": [P("Gus", "Affiliate Manager", "fresh.com"), P("Hal", "Director of Partnerships", "fresh.com")],
};
const B_PEOPLE: Record<string, ProviderPerson[]> = { "buyer.com": [P("Ann", "Affiliate Manager"), P("Fay", "Director of Lead Generation")] };
let providerA: StaticContactProvider;
let providerB: StaticContactProvider;
let deps: ContactDataDeps;
const titles = ["Affiliate Manager", "Director of Partnerships", "Director of Lead Generation"];
const synonyms = { partnerships_director: ["head of partnerships"] };

async function account(tx: TenantTx, domain: string) {
  return (await createAccount(tx, keyring, actor, { name: domain, domain }, "return")).account.id;
}

beforeAll(async () => {
  t = await setupTestDb();
  for (const tn of [t.tenantA, t.tenantB]) {
    await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, $3, 'h@a.vn', 'owner')", [tn === t.tenantA ? userId : randomUUID(), tn, `w-${tn}`]);
  }
  await t.admin.query(`INSERT INTO abcrm.data_providers(id, key, kind, priority, license, status) VALUES
    ($1, 'prov_a', 'contact_finder', 1, '{"resale_ok": true, "cache_scope": "global", "ttl_days": 30}', 'active'),
    ($2, 'prov_b', 'contact_finder', 2, '{"resale_ok": true, "cache_scope": "none"}', 'active')`, [randomUUID(), randomUUID()]);
});
afterAll(async () => { await t?.close(); });
beforeEach(async () => {
  providerA = new StaticContactProvider("prov_a", PEOPLE, 50_000);
  providerB = new StaticContactProvider("prov_b", B_PEOPLE, 80_000);
  deps = { pool: t.app, global: t.global, keyring, platform, providers: [providerA, providerB], verifier: new StaticVerifier("verifier", { "eve@buyer.com": "catch_all", "dan@buyer.com": "invalid" }) };
  await t.admin.query("DELETE FROM abcrm.licensed_contact_cache");
  await t.admin.query("DELETE FROM abcrm.global_data_suppression");
});

describe("findContacts", () => {
  it("runs the waterfall, matches titles, verifies, writes encrypted contacts and charges per result", async () => {
    const accountId = await inA((tx) => account(tx, "buyer.com"));
    const r = await findContacts(deps, t.tenantA, actor, { accountId, titles, synonyms, limit: 3 });
    // prov_a has only 2 exact matches → prov_b adds Fay. Dan (weak) fails verification; Bob and Cat do not match.
    expect(r.contacts.map((c) => [c.title, c.titleMatch, c.emailStatus])).toEqual([
      ["Affiliate Manager", "exact", "valid"], ["Director of Lead Generation", "exact", "valid"], ["Affiliate Mgr", "exact", "catch_all"]]);
    expect(r.contacts.map((c) => c.preselected)).toEqual([true, true, false]);
    expect(r.contactCredits).toBe(2.5);
    expect(r.providersTried.map((p) => p.provider_key)).toEqual(["prov_a", "prov_b"]);

    const rows = await inA(async (tx) => (await tx.client.query(
      "SELECT email_enc, email_verification->>'result' AS v, seniority, source->>'provider' AS provider FROM abcrm.contacts WHERE account_id = $1 ORDER BY id", [accountId])).rows);
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => !(x.email_enc as Buffer).toString("latin1").includes("buyer.com"))).toBe(true);
    expect(rows.map((x) => x.provider)).toEqual(["prov_a", "prov_b", "prov_a"]);
    const usage = await inA(async (tx) => (await tx.client.query("SELECT action_type, credits::float AS c FROM abcrm.usage_events WHERE meter = 'contact' ORDER BY action_type")).rows);
    expect(usage).toEqual([{ action_type: "contact_catch_all", c: 0.5 }, { action_type: "contact_valid", c: 1 }, { action_type: "contact_valid", c: 1 }]);
    const costs = await inA(async (tx) => (await tx.client.query("SELECT kind, vendor, cost_usd_micros::int AS m FROM abcrm.cost_ledger WHERE kind = 'contact_provider' ORDER BY vendor")).rows);
    expect(costs).toEqual([{ kind: "contact_provider", vendor: "prov_a", m: 50_000 }, { kind: "contact_provider", vendor: "prov_b", m: 80_000 }]);
  });

  it("is idempotent per lookup id and does not charge twice for a contact the tenant already has", async () => {
    const accountId = await inA((tx) => account(tx, "buyer.com"));
    const lookupId = randomUUID();
    const first = await findContacts(deps, t.tenantA, actor, { lookupId, accountId, titles, limit: 1 });
    const again = await findContacts(deps, t.tenantA, actor, { lookupId, accountId, titles, limit: 1 });
    expect(again).toEqual(first);
    const fresh = await findContacts(deps, t.tenantA, actor, { accountId, titles, limit: 1 });
    expect(fresh.contacts[0]!.contactId).toBe(first.contacts[0]!.contactId);
    expect(fresh.contactCredits).toBe(0);
  });

  it("serves a second tenant from the licensed cache without calling the provider, and keeps tenants separate", async () => {
    await inA((tx) => account(tx, "buyer.com"));
    const accountB = await inB((tx) => account(tx, "buyer.com"));
    const accountA = await inA((tx) => account(tx, "buyer.com"));
    await findContacts(deps, t.tenantA, actor, { accountId: accountA, titles, limit: 2 });
    const callsA = providerA.calls;
    const rB = await findContacts(deps, t.tenantB, { type: "system", id: "s2" }, { accountId: accountB, titles, limit: 2 });
    expect(providerA.calls).toBe(callsA);
    expect(rB.providersTried[0]).toMatchObject({ provider_key: "prov_a", cache_hit: true });
    expect(rB.contacts.length).toBe(2);
    expect(rB.contactCredits).toBeGreaterThan(0);   // each tenant pays for what it receives
    const cache = await t.admin.query("SELECT payload_enc FROM abcrm.licensed_contact_cache");
    expect(cache.rows.length).toBe(PEOPLE["buyer.com"]!.length);
    expect(cache.rows.every((r) => !(r.payload_enc as Buffer).toString("latin1").includes("buyer.com"))).toBe(true);
    // Tenant B cannot see tenant A's contacts.
    const seen = await inB(async (tx) => (await tx.client.query("SELECT count(*)::int AS n FROM abcrm.contacts WHERE account_id = $1", [accountA])).rows[0].n);
    expect(seen).toBe(0);
  });

  it("drops globally suppressed people and domains, and tenant-suppressed emails", async () => {
    const accountId = await inA((tx) => account(tx, "buyer.com"));
    await addGlobalSuppression(t.global, platform, { kind: "email", value: "Ann@Buyer.com", reason: "opt_out", source: "privacy_portal" });
    await inA((tx) => addSuppression(tx, keyring, actor, { kind: "email", value: "fay@buyer.com", reason: "unsubscribe" }));
    const r = await findContacts(deps, t.tenantA, actor, { accountId, titles, limit: 5 });
    expect(r.contacts.map((c) => c.title)).not.toContain("Affiliate Manager");
    expect(r.contacts.map((c) => c.title)).not.toContain("Director of Lead Generation");

    const other = await inA((tx) => account(tx, "optedout.com"));
    await addGlobalSuppression(t.global, platform, { kind: "domain", value: "optedout.com", reason: "legal", source: "legal" });
    const r2 = await findContacts(deps, t.tenantA, actor, { accountId: other, titles, limit: 2 });
    expect(r2).toMatchObject({ contacts: [], contactCredits: 0, reason: "domain_suppressed" });
  });

  it("respects the credit budget and refuses accounts of another tenant", async () => {
    const accountId = await inA((tx) => account(tx, "fresh.com"));
    const r = await findContacts(deps, t.tenantA, actor, { accountId, titles, limit: 3, creditBudget: 1 });
    expect(r.contacts).toHaveLength(1);
    expect(r.contactCredits).toBe(1);
    await expect(findContacts(deps, t.tenantB, actor, { accountId, titles, limit: 1 })).rejects.toMatchObject({ status: 404 });
  });

  it("completes with nothing when no provider is configured", async () => {
    const accountId = await inA((tx) => account(tx, "buyer.com"));
    const r = await findContacts({ ...deps, providers: [] }, t.tenantA, actor, { accountId, titles, limit: 1 });
    expect(r).toMatchObject({ contacts: [], reason: "no_providers" });
  });
});
