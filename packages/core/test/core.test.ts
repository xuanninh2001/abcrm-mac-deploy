import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalKeyProvider, generateKey } from "@abcrm/crypto";
import { withTenant } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { appendAudit, canonicalJson, emit, TenantKeyring, uuidv7, verifyAuditChain } from "../src/index.js";

const sys = { type: "system", id: "test" } as const;
let t: TestDb;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t?.close(); });

describe("ids & canonical json", () => {
  it("uuidv7 has version/variant bits and sorts by time", () => {
    const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
  it("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});

describe("audit hash chain", () => {
  it("chains per tenant and detects tampering", async () => {
    await withTenant(t.app, t.tenantA, sys, async (tx) => {
      for (let i = 0; i < 5; i++) await appendAudit(tx, { actor: sys, action: "test.event", subject: { type: "x", id: String(i) } });
    });
    await withTenant(t.app, t.tenantB, sys, (tx) => appendAudit(tx, { actor: sys, action: "test.event", subject: { type: "x", id: "b" } }));
    expect(await withTenant(t.app, t.tenantA, sys, verifyAuditChain)).toBeNull();
    expect(await withTenant(t.app, t.tenantB, sys, verifyAuditChain)).toBeNull();

    // Tamper as superuser (app role cannot UPDATE audit_log).
    await t.admin.query("UPDATE abcrm.audit_log SET action = 'tampered' WHERE tenant_id = $1 AND subject->>'id' = '2'", [t.tenantA]);
    expect(await withTenant(t.app, t.tenantA, sys, verifyAuditChain)).not.toBeNull();
  });
});

describe("outbox", () => {
  it("writes events within the tenant transaction only", async () => {
    await withTenant(t.app, t.tenantA, sys, (tx) => emit(tx, "iam.tenant.created", { plan: "trial" }));
    await expect(withTenant(t.app, t.tenantA, sys, async (tx) => {
      await emit(tx, "never.committed", {});
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    const { rows } = await t.admin.query("SELECT topic FROM abcrm.outbox WHERE tenant_id = $1", [t.tenantA]);
    expect(rows.map((r) => r.topic)).toEqual(["iam.tenant.created"]);
  });
});

describe("tenant keyring", () => {
  it("creates per-tenant keys lazily; ciphertext is bound to tenant", async () => {
    const ring = new TenantKeyring(new LocalKeyProvider(generateKey()));
    const blob = await withTenant(t.app, t.tenantA, sys, (tx) => ring.encrypt(tx, "contacts.email", "jane@acme.com"));
    expect(await withTenant(t.app, t.tenantA, sys, (tx) => ring.decrypt(tx, "contacts.email", blob))).toBe("jane@acme.com");
    await expect(withTenant(t.app, t.tenantB, sys, (tx) => ring.decrypt(tx, "contacts.email", blob))).rejects.toThrow();

    const a = await withTenant(t.app, t.tenantA, sys, (tx) => ring.bidx(tx, "email", "jane@acme.com"));
    const b = await withTenant(t.app, t.tenantB, sys, (tx) => ring.bidx(tx, "email", "jane@acme.com"));
    expect(a.equals(b)).toBe(false);   // blind indexes are not linkable across tenants
  });
});

describe("audit chain under burst", () => {
  it("stays verifiable when many entries land in the same millisecond", async () => {
    await withTenant(t.app, t.tenantB, sys, async (tx) => {
      for (let i = 0; i < 50; i++) await appendAudit(tx, { actor: sys, action: "burst", subject: { type: "x", id: String(i) } });
    });
    expect(await withTenant(t.app, t.tenantB, sys, verifyAuditChain)).toBeNull();
  });
});
