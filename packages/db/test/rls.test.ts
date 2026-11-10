import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { checkRlsCoverage, createTenant, schema, withTenant } from "../src/index.js";
import { setupTestDb, type TestDb } from "../src/testing.js";

let t: TestDb;
const sys = { type: "system", id: "test" } as const;

beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t?.close(); });

async function insertAccount(tenantId: string, domain: string) {
  return withTenant(t.app, tenantId, sys, async (tx) => {
    const id = randomUUID();
    await tx.client.query(
      "INSERT INTO abcrm.accounts(id, tenant_id, name, domain, domain_bidx) VALUES ($1, $2, $3, $4, $5)",
      [id, tenantId, domain, domain, Buffer.from(domain)],
    );
    return id;
  });
}

describe("tenant isolation (RLS)", () => {
  it("a tenant cannot read another tenant's rows", async () => {
    const id = await insertAccount(t.tenantA, "acme.com");
    const seen = await withTenant(t.app, t.tenantB, sys, async (tx) =>
      (await tx.client.query("SELECT id FROM abcrm.accounts WHERE id = $1", [id])).rowCount);
    expect(seen).toBe(0);
  });

  it("a tenant cannot write rows for another tenant", async () => {
    await expect(withTenant(t.app, t.tenantB, sys, (tx) =>
      tx.client.query("INSERT INTO abcrm.accounts(id, tenant_id, name, domain, domain_bidx) VALUES ($1, $2, 'x', 'x.com', '\\x01')",
        [randomUUID(), t.tenantA]))).rejects.toThrow(/row-level security/);
  });

  it("queries without tenant context see nothing", async () => {
    await insertAccount(t.tenantA, "nocontext.com");
    const { rowCount } = await t.app.query("SELECT 1 FROM abcrm.accounts");
    expect(rowCount).toBe(0);
  });

  it("the app role cannot touch global tables", async () => {
    await expect(t.app.query("SELECT 1 FROM abcrm.public_pages")).rejects.toThrow(/permission denied/);
    await expect(t.app.query("SELECT 1 FROM abcrm.global_data_suppression")).rejects.toThrow(/permission denied/);
  });

  it("the app role cannot read partitions directly", async () => {
    await expect(t.app.query("SELECT 1 FROM abcrm.audit_log_default")).rejects.toThrow(/permission denied/);
  });

  it("append-only tables reject UPDATE/DELETE from the app role", async () => {
    await expect(withTenant(t.app, t.tenantA, sys, (tx) => tx.client.query("DELETE FROM abcrm.audit_log")))
      .rejects.toThrow(/permission denied/);
  });

  it("criteria of an active playbook are immutable", async () => {
    const playbookId = randomUUID();
    await withTenant(t.app, t.tenantA, sys, (tx) => tx.client.query(
      "INSERT INTO abcrm.playbooks(id, tenant_id, lineage_id, name, version, status, definition_hash) VALUES ($1, $2, $3, 'P', 1, 'active', 'h')",
      [playbookId, t.tenantA, randomUUID()]));
    await expect(withTenant(t.app, t.tenantA, sys, (tx) => tx.client.query(
      "INSERT INTO abcrm.criteria(id, tenant_id, playbook_id, key, name, description, kind, evaluation, order_no) VALUES ($1, $2, $3, 'k', 'n', 'd', 'scored', 'ai_judged', 1)",
      [randomUUID(), t.tenantA, playbookId]))).rejects.toThrow(/immutable/);
  });

  it("withTenant rejects malformed tenant ids", async () => {
    await expect(withTenant(t.app, "'; drop table x; --", sys, async () => 1)).rejects.toThrow(/invalid tenant id/);
  });
});

describe("schema guards", () => {
  it("every non-global table has forced RLS and no partition is directly accessible", async () => {
    expect(await checkRlsCoverage(t.admin)).toEqual([]);
  });

  it("drizzle definitions match the migrated schema", async () => {
    for (const table of Object.values(schema)) {
      const name = getTableName(table);
      const { rows } = await t.admin.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'abcrm' AND table_name = $1", [name]);
      const dbCols = new Set(rows.map((r) => r.column_name));
      for (const col of Object.values(getTableColumns(table))) {
        expect(dbCols.has(col.name), `${name}.${col.name}`).toBe(true);
      }
    }
  });
});

describe("tenant onboarding", () => {
  it("creates the tenant and an invited owner with a lower-case email, atomically", async () => {
    const r = await createTenant(t.admin, { name: "Acme Leads", slug: "acme-leads", country: "VN", workosOrgId: "org_acme", owner: { email: "Owner@Acme.vn", name: "Owner" } });
    const { rows: [u] } = await t.admin.query("SELECT tenant_id, email, role, status, workos_user_id FROM abcrm.users WHERE id = $1", [r.ownerId]);
    expect(u).toEqual({ tenant_id: r.tenantId, email: "owner@acme.vn", role: "owner", status: "invited", workos_user_id: `invite:${r.ownerId}` });
    expect((await t.admin.query("SELECT topic FROM abcrm.outbox WHERE tenant_id = $1", [r.tenantId])).rows).toEqual([{ topic: "iam.tenant.created" }]);
    // First WorkOS sign-in with the verified owner email activates the seat.
    const { rows: [a] } = await t.app.query("SELECT * FROM abcrm.activate_workos_invite('org_acme', 'user_owner', 'owner@acme.vn')");
    expect(a).toEqual({ tenant_id: r.tenantId, user_id: r.ownerId, role: "owner" });
    await expect(createTenant(t.admin, { name: "Dup", slug: "acme-leads", owner: { email: "x@y.vn" } })).rejects.toThrow();
    expect((await t.admin.query("SELECT count(*)::int AS n FROM abcrm.tenants WHERE name = 'Dup'")).rows[0].n).toBe(0);
    await expect(createTenant(t.admin, { name: "Bad", slug: "Bad Slug", owner: { email: "x@y.vn" } })).rejects.toThrow(/slug/);
  });
});
