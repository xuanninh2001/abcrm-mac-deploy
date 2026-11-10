import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { withTenant } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { approveDecision, contentHash, proposeDecision } from "@abcrm/agents";
import { launchEngine, shutdownEngine } from "../src/engine.js";
import { dispatchOnce } from "../src/dispatcher.js";
import { registerDecisionWait, startDecisionWait } from "../src/workflows/decision-wait.js";

let t: TestDb;
let wf: ReturnType<typeof registerDecisionWait>;
const repId = randomUUID();
const sys = { type: "system", id: "test" } as const;
const action = { tool: "account.approve_contact", args: { accountId: "a" } };
const rep = () => ({ type: "user" as const, id: repId, role: "sales_rep" as const });

beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'w', 'r@a.vn', 'sales_rep')", [repId, t.tenantA]);
  wf = registerDecisionWait(t.app);
  await launchEngine(t.adminUrl);
});
afterAll(async () => { await shutdownEngine(); await t?.close(); });

const propose = () => withTenant(t.app, t.tenantA, sys, (tx) => proposeDecision(tx, {
  gate: "G-Q", lane: "contact", subject: { type: "account", id: randomUUID() }, action, proposedBy: { type: "agent", agentRunId: randomUUID() } }));

describe("decision wait workflow", () => {
  it("resumes when a person approves (outbox → dispatcher → DBOS.send)", async () => {
    const id = await propose();
    const handle = await startDecisionWait(wf, t.tenantA, id, 60);
    await withTenant(t.app, t.tenantA, sys, (tx) => approveDecision(tx, id, rep(), contentHash(action)));
    while ((await dispatchOnce(t.app)) > 0);
    expect(await handle.getResult()).toBe("approved");
  });

  it("expires a pending decision on timeout", async () => {
    const id = await propose();
    const handle = await startDecisionWait(wf, t.tenantA, id, 1);
    expect(await handle.getResult()).toBe("expired");
    const { rows: [d] } = await t.admin.query("SELECT status FROM abcrm.decisions WHERE id = $1", [id]);
    expect(d.status).toBe("expired");
  });

  it("does not overwrite a decision that was made without a signal reaching the workflow", async () => {
    const id = await propose();
    const handle = await startDecisionWait(wf, t.tenantA, id, 2);
    await withTenant(t.app, t.tenantA, sys, (tx) => approveDecision(tx, id, rep(), contentHash(action)));   // dispatcher not run
    expect(await handle.getResult()).toBe("approved");
  });

  it("dispatching is idempotent and skips decisions without a waiting workflow", async () => {
    const id = await propose();   // nobody waits on this one
    await withTenant(t.app, t.tenantA, sys, (tx) => approveDecision(tx, id, rep(), contentHash(action)));
    while ((await dispatchOnce(t.app)) > 0);
    const { rows } = await t.admin.query("SELECT count(*)::int AS n FROM abcrm.outbox WHERE dispatched_at IS NULL");
    expect(rows[0].n).toBe(0);
    expect(await DBOS.getWorkflowStatus(`decision-wait:${id}`)).toBeNull();
  });
});

describe("restart durability", () => {
  it("a parked workflow survives an engine restart and still completes", async () => {
    const id = await propose();
    await startDecisionWait(wf, t.tenantA, id, 120);
    await shutdownEngine();
    await launchEngine(t.adminUrl);   // DBOS recovers pending workflows on launch
    await withTenant(t.app, t.tenantA, sys, (tx) => approveDecision(tx, id, rep(), contentHash(action)));
    while ((await dispatchOnce(t.app)) > 0);
    expect(await DBOS.retrieveWorkflow<string>(`decision-wait:${id}`).getResult()).toBe("approved");
  });
});
