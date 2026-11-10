import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import {
  addSuppression, createAccount, createContact, createOpportunity, getContact, listContacts, listSuppression,
  removeSuppression, setAccountFlags, updateAccount, updateContact, updateOpportunity,
} from "../src/index.js";

let t: TestDb;
const keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));
const actor = { type: "user", id: randomUUID() } as const;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t?.close(); });
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, actor, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantB, actor, fn);

describe("accounts", () => {
  it("upserts by registrable domain and records field history", async () => {
    const { account, created } = await inA((tx) => createAccount(tx, keyring, actor, { name: "Acme", domain: "www.acme-ins.com" }));
    expect(created).toBe(true);
    const again = await inA((tx) => createAccount(tx, keyring, actor, { name: "Acme Insurance", domain: "https://leads.acme-ins.com/x" }, "return"));
    expect(again).toMatchObject({ created: false, account: { id: account.id } });
    await expect(inA((tx) => createAccount(tx, keyring, actor, { name: "x", domain: "acme-ins.com" }))).rejects.toThrow(/already exists/);

    const updated = await inA((tx) => updateAccount(tx, actor, account.id, { hq_state: "FL", verticals: ["insurance"] }));
    expect(updated).toMatchObject({ hq_state: "FL", verticals: ["insurance"] });
    const { rows } = await t.admin.query("SELECT field FROM abcrm.record_changes WHERE record_id = $1 ORDER BY field", [account.id]);
    expect(rows.map((r) => r.field)).toEqual(["hq_state", "verticals"]);
  });

  it("ignores non-allowlisted patch keys", async () => {
    const { account } = await inA((tx) => createAccount(tx, keyring, actor, { name: "Safe", domain: "safe.com" }));
    const patch = { name: "Renamed", "tenant_id = NULL, name": "x" } as unknown as Parameters<typeof updateAccount>[3];
    expect(await inA((tx) => updateAccount(tx, actor, account.id, patch))).toMatchObject({ name: "Renamed" });
  });

  it("sets and clears flags", async () => {
    const { account } = await inA((tx) => createAccount(tx, keyring, actor, { name: "Rival", domain: "rival.com" }));
    expect((await inA((tx) => setAccountFlags(tx, actor, account.id, ["competitor", "do_not_contact"], []))).flags).toEqual(["competitor", "do_not_contact"]);
    expect((await inA((tx) => setAccountFlags(tx, actor, account.id, [], ["do_not_contact"]))).flags).toEqual(["competitor"]);
  });
});

describe("contacts", () => {
  it("encrypts PII at rest and dedupes by email", async () => {
    const { account } = await inA((tx) => createAccount(tx, keyring, actor, { name: "Buyer", domain: "buyer.com" }));
    const { contact } = await inA((tx) => createContact(tx, keyring, actor, account.id, {
      firstName: "Jane", lastName: "Doe", title: "Affiliate Manager", email: " Jane.Doe@Buyer.com ", source: { kind: "manual" } }));
    expect(contact).toMatchObject({ first_name: "Jane", email: "jane.doe@buyer.com", status: "active" });

    const raw = await t.admin.query("SELECT first_name_enc, email_enc FROM abcrm.contacts WHERE id = $1", [contact.id]);
    expect(raw.rows[0].email_enc.toString("latin1")).not.toContain("jane");
    const dup = await inA((tx) => createContact(tx, keyring, actor, account.id, { email: "jane.doe@buyer.com", source: { kind: "import" } }, "return"));
    expect(dup).toMatchObject({ created: false, contact: { id: contact.id } });

    expect(await inA((tx) => listContacts(tx, keyring, account.id))).toHaveLength(1);
    const upd = await inA((tx) => updateContact(tx, keyring, actor, contact.id, { title: "Director of Partnerships", phone: "+1 555 0100" }));
    expect(upd).toMatchObject({ title: "Director of Partnerships", phone: "+1 555 0100", email: "jane.doe@buyer.com" });
  });

  it("cannot attach contacts to another tenant's account or read them", async () => {
    const { account } = await inA((tx) => createAccount(tx, keyring, actor, { name: "Mine", domain: "mine.com" }));
    const { contact } = await inA((tx) => createContact(tx, keyring, actor, account.id, { email: "a@mine.com", source: { kind: "manual" } }));
    await expect(inB((tx) => createContact(tx, keyring, actor, account.id, { email: "b@mine.com", source: { kind: "manual" } }))).rejects.toThrow(/not found/);
    await expect(inB((tx) => getContact(tx, keyring, contact.id))).rejects.toThrow(/not found/);
  });
});

describe("suppression", () => {
  it("suppresses existing contacts by email and by domain, and new contacts on creation", async () => {
    const { account } = await inA((tx) => createAccount(tx, keyring, actor, { name: "Opt", domain: "optout.com" }));
    const c1 = (await inA((tx) => createContact(tx, keyring, actor, account.id, { email: "x@optout.com", source: { kind: "manual" } }))).contact;
    const c2 = (await inA((tx) => createContact(tx, keyring, actor, account.id, { email: "y@optout.com", source: { kind: "manual" } }))).contact;

    const r1 = await inA((tx) => addSuppression(tx, keyring, actor, { kind: "email", value: "X@optout.com", reason: "unsubscribe" }));
    expect(r1).toMatchObject({ created: true, contactsSuppressed: 1 });
    expect((await inA((tx) => getContact(tx, keyring, c1.id))).status).toBe("suppressed");
    expect((await inA((tx) => getContact(tx, keyring, c2.id))).status).toBe("active");

    expect((await inA((tx) => addSuppression(tx, keyring, actor, { kind: "domain", value: "optout.com", reason: "manual" }))).contactsSuppressed).toBe(1);
    const c3 = (await inA((tx) => createContact(tx, keyring, actor, account.id, { email: "z@optout.com", source: { kind: "manual" } }))).contact;
    expect(c3.status).toBe("suppressed");

    const list = await inA((tx) => listSuppression(tx, keyring, { limit: 50 }));
    expect(list.data.map((e) => e.value).sort()).toEqual(["optout.com", "x@optout.com"]);
    expect((await inB((tx) => listSuppression(tx, keyring, { limit: 50 }))).data).toHaveLength(0);
  });

  it("legal opt-outs cannot be removed; manual entries can", async () => {
    const legal = await inA((tx) => addSuppression(tx, keyring, actor, { kind: "email", value: "legal@x.com", reason: "unsubscribe" }));
    await expect(inA((tx) => removeSuppression(tx, actor, legal.id))).rejects.toThrow(/cannot be removed/);
    const manual = await inA((tx) => addSuppression(tx, keyring, actor, { kind: "email", value: "manual@x.com", reason: "manual" }));
    await inA((tx) => removeSuppression(tx, actor, manual.id));
    expect((await inA((tx) => addSuppression(tx, keyring, actor, { kind: "email", value: "manual@x.com", reason: "manual" }))).created).toBe(true);
  });
});

describe("pipeline", () => {
  it("opportunity moves account status and stage changes are tracked", async () => {
    const { account } = await inA((tx) => createAccount(tx, keyring, actor, { name: "Opp", domain: "opp.com" }));
    const opp = await inA((tx) => createOpportunity(tx, actor, { accountId: account.id, expectedMonthlyValue: 15000 }));
    const { rows: [a1] } = await t.admin.query("SELECT status FROM abcrm.accounts WHERE id = $1", [account.id]);
    expect(a1.status).toBe("opportunity");
    await inA((tx) => updateOpportunity(tx, actor, opp.id, { stage: "lost", lost_reason: "price" }));
    const { rows: [a2] } = await t.admin.query("SELECT status FROM abcrm.accounts WHERE id = $1", [account.id]);
    expect(a2.status).toBe("lost");
  });
});
