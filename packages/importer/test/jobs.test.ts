import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { listContacts } from "@abcrm/crm";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { approveMapping, commitImport, dryRun, getImportJob, listImportRows, parseCsvBuffer, rollbackImport, stageImport, type Purpose } from "../src/index.js";

let t: TestDb;
const keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));
const actor = { type: "user", id: randomUUID() } as const;
beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'adm', 'admin@a.vn', 'admin')", [actor.id, t.tenantA]);
});
afterAll(async () => { await t?.close(); });
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, actor, fn);

async function stage(csv: string, purpose: Purpose) {
  return inA((tx) => stageImport(tx, actor, { purpose, filename: "x.csv", source: "csv", sheets: [parseCsvBuffer(Buffer.from(csv))] }));
}
async function runToReady(csv: string, purpose: Purpose) {
  const s = await stage(csv, purpose);
  await inA((tx) => approveMapping(tx, actor, s.jobId, s.fieldMap));
  const stats = await inA((tx) => dryRun(tx, s.jobId));
  return { ...s, stats };
}

const CONTACTS = `First Name,Last Name,Title,Company,Email,Website
Jane,Doe,Affiliate Manager,Acme Health Leads,jane@acmehealthleads.com,acmehealthleads.com
John,Roe,VP Growth,Acme Health Leads,john@acmehealthleads.com,acmehealthleads.com
Dup,Row,x,Acme Health Leads,JANE@acmehealthleads.com,acmehealthleads.com
Bad,Mail,x,Personal,bob@gmail.com,
Sam,Lee,Director of Partnerships,Beta Leads,sam@betaleads.io,`;

describe("import lifecycle", () => {
  it("dry-run requires an approved mapping and reports per-row status", async () => {
    const s = await stage(CONTACTS, "contacts");
    await expect(inA((tx) => dryRun(tx, s.jobId))).rejects.toThrow(/Approve the mapping/);
    await expect(inA((tx) => approveMapping(tx, actor, s.jobId, s.fieldMap.filter((f) => f.target !== "email" && f.target !== "company_domain"))))
      .rejects.toThrow(/Required fields/);
    await inA((tx) => approveMapping(tx, actor, s.jobId, s.fieldMap));
    const stats = await inA((tx) => dryRun(tx, s.jobId));
    expect(stats).toEqual({ rows: 5, valid: 2, warning: 1, error: 1, duplicate_in_file: 1 });
    const errors = await inA((tx) => listImportRows(tx, s.jobId, { status: "error", limit: 10 }));
    expect(errors).toMatchObject([{ row_no: 5, errors: ["personal email and no company domain"] }]);
    // Nothing was written before commit.
    const { rows } = await t.admin.query("SELECT count(*)::int AS n FROM abcrm.contacts WHERE tenant_id = $1", [t.tenantA]);
    expect(rows[0].n).toBe(0);
  });

  it("commits contacts (creating accounts), re-import matches instead of duplicating, rollback keeps modified records", async () => {
    const first = await runToReady(CONTACTS, "contacts");
    expect(await inA((tx) => commitImport(tx, keyring, actor, first.jobId))).toEqual({ created: 3, matched: 0, suppressed: 0 });
    await expect(inA((tx) => commitImport(tx, keyring, actor, first.jobId))).rejects.toThrow(/Already committed/);

    const second = await runToReady(CONTACTS, "contacts");
    expect(await inA((tx) => commitImport(tx, keyring, actor, second.jobId))).toEqual({ created: 0, matched: 3, suppressed: 0 });

    // Someone edits Sam after the import: rollback must keep Sam (and therefore Beta's account).
    await new Promise((r) => setTimeout(r, 20));
    const { rows: [sam] } = await t.admin.query("SELECT id, account_id FROM abcrm.contacts WHERE tenant_id = $1 AND title = 'Director of Partnerships'", [t.tenantA]);
    await withTenant(t.app, t.tenantA, actor, (tx) => tx.client.query("UPDATE abcrm.contacts SET timezone = 'America/New_York' WHERE id = $1", [sam.id]));

    expect(await inA((tx) => rollbackImport(tx, actor, second.jobId))).toEqual({ deleted: 0, kept_modified: 0 });   // matched only → no-op
    const rb = await inA((tx) => rollbackImport(tx, actor, first.jobId));
    expect(rb).toMatchObject({ kept_modified: 1 });
    const { rows } = await t.admin.query("SELECT domain FROM abcrm.accounts WHERE tenant_id = $1 ORDER BY domain", [t.tenantA]);
    expect(rows.map((r) => r.domain)).toEqual(["betaleads.io"]);
    expect(await inA((tx) => listContacts(tx, keyring, sam.account_id))).toHaveLength(1);
    expect((await inA((tx) => getImportJob(tx, first.jobId))).status).toBe("rolled_back");
  });

  it("blocklist imports suppress matching contacts; existing_buyers flags accounts", async () => {
    const contacts = await runToReady("Email,Website\nceo@rival.com,rival.com\n", "contacts");
    await inA((tx) => commitImport(tx, keyring, actor, contacts.jobId));
    const block = await runToReady("Value\nrival.com\nstop@other.com\n", "blocklist");
    expect(await inA((tx) => commitImport(tx, keyring, actor, block.jobId))).toMatchObject({ created: 2, suppressed: 1 });
    const { rows: [c] } = await t.admin.query("SELECT status FROM abcrm.contacts WHERE tenant_id = $1 AND account_id = (SELECT id FROM abcrm.accounts WHERE domain = 'rival.com' AND tenant_id = $1)", [t.tenantA]);
    expect(c.status).toBe("suppressed");

    const buyers = await runToReady("Company,Domain\nPartner Co,partnerco.com\n", "existing_buyers");
    await inA((tx) => commitImport(tx, keyring, actor, buyers.jobId));
    const { rows: [a] } = await t.admin.query("SELECT flags, source FROM abcrm.accounts WHERE tenant_id = $1 AND domain = 'partnerco.com'", [t.tenantA]);
    expect(a).toMatchObject({ flags: ["existing_buyer"], source: { kind: "import", import_job_id: buyers.jobId } });
  });

  it("jobs are tenant-scoped", async () => {
    const s = await stage("Domain\nacme.com\n", "accounts");
    await expect(withTenant(t.app, t.tenantB, actor, (tx) => getImportJob(tx, s.jobId))).rejects.toThrow(/not found/);
  });
});
