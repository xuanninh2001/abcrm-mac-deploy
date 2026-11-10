import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { z } from "zod";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import {
  approveDecision, contentHash, defineTool, evaluateToolCall, executeApproved, proposeDecision, rejectDecision,
  type Principal, type Role, type ToolCtx,
} from "../src/index.js";

let t: TestDb;
let repId: string;
const sys = { type: "system", id: "test" } as const;
beforeAll(async () => {
  t = await setupTestDb();
  repId = randomUUID();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'wu_1', 'rep@agency.vn', 'sales_rep')", [repId, t.tenantA]);
});
afterAll(async () => { await t?.close(); });

const rep = (): Principal => ({ type: "user", id: repId, role: "sales_rep" });
const persona: Principal = { type: "persona", id: randomUUID(), key: "qualification" };
const action = { tool: "account.approve_contact", args: { accountId: "a1", contactIds: ["c1"] } };

async function newCard(tx: TenantTx) {
  return proposeDecision(tx, {
    gate: "G-Q", lane: "contact", subject: { type: "account", id: randomUUID() }, action,
    proposedBy: { type: "agent", agentRunId: randomUUID() }, cardId: randomUUID(),
  });
}

describe("policy (evaluateToolCall)", () => {
  const tx = {} as TenantTx;
  const ctx = (p: Principal, extra: Partial<ToolCtx> = {}): ToolCtx =>
    ({ tenantId: "t", actor: { type: "agent", runId: "r" }, onBehalfOf: p, tx, killSwitch: false, ...extra });
  const internal = defineTool({ name: "scorecard.finalize", description: "", sideEffect: "internal", permission: "qualification.write",
    exposeToLLM: false, input: z.object({}), output: z.object({}), execute: async () => ({}) });
  const gated = defineTool({ name: "card.propose_contact", description: "", sideEffect: "internal", gate: "G-Q", permission: "decisions.propose",
    exposeToLLM: false, input: z.object({}), output: z.object({}), execute: async () => ({}) });

  it("executes permitted internal tools, proposes gated tools, denies on kill switch / missing permission", () => {
    expect(evaluateToolCall(internal, ctx(persona))).toEqual({ verdict: "execute" });
    expect(evaluateToolCall(gated, ctx(persona))).toEqual({ verdict: "propose", gate: "G-Q" });
    expect(evaluateToolCall(gated, ctx(persona, { approvedDecisionId: "d" }))).toEqual({ verdict: "execute" });
    expect(evaluateToolCall(internal, ctx(persona, { killSwitch: true })).verdict).toBe("deny");
    expect(evaluateToolCall(internal, ctx({ type: "persona", id: "x", key: "sourcing" })).verdict).toBe("deny");
  });

  it("refuses to define external tools without a gate", () => {
    expect(() => defineTool({ name: "email.send", description: "", sideEffect: "external", permission: "crm.write",
      exposeToLLM: true, input: z.object({}), output: z.object({}), execute: async () => ({}) })).toThrow(/gate/);
  });

  it("a gated tool is never executed without an approved decision, for any principal (property)", () => {
    const roles: Role[] = ["owner", "admin", "head_of_bd", "sales_rep", "viewer"];
    const principal = fc.oneof(
      fc.constantFrom(...roles).map((role): Principal => ({ type: "user", id: "u", role })),
      fc.constantFrom("sourcing", "qualification", "unknown").map((key): Principal => ({ type: "persona", id: "p", key })),
    );
    fc.assert(fc.property(principal, fc.boolean(), (p, kill) => {
      expect(evaluateToolCall(gated, ctx(p, { killSwitch: kill })).verdict).not.toBe("execute");
    }));
  });
});

describe("decisions", () => {
  it("INV-2: agents/personas cannot approve; viewers cannot approve", async () => {
    const id = await withTenant(t.app, t.tenantA, sys, newCard);
    await expect(withTenant(t.app, t.tenantA, sys, (tx) => approveDecision(tx, id, persona, contentHash(action)))).rejects.toThrow(/Only people/);
    await expect(withTenant(t.app, t.tenantA, sys, (tx) => approveDecision(tx, id, { type: "user", id: repId, role: "viewer" }, contentHash(action))))
      .rejects.toThrow(/Not allowed/);
  });

  it("rejects approval when the reviewed content hash is stale", async () => {
    const id = await withTenant(t.app, t.tenantA, sys, newCard);
    await expect(withTenant(t.app, t.tenantA, sys, (tx) => approveDecision(tx, id, rep(), contentHash({ ...action, args: {} }))))
      .rejects.toThrow(/changed/);
  });

  it("a decision from another tenant is invisible", async () => {
    const id = await withTenant(t.app, t.tenantA, sys, newCard);
    await expect(withTenant(t.app, t.tenantB, sys, (tx) => approveDecision(tx, id, rep(), contentHash(action)))).rejects.toThrow(/not found/);
  });

  it("approve → execute exactly once under concurrency (INV-3), with edits applied", async () => {
    const id = await withTenant(t.app, t.tenantA, sys, newCard);
    const edited = { tool: action.tool, args: { accountId: "a1", contactIds: ["c2"] } };
    await withTenant(t.app, t.tenantA, sys, (tx) => approveDecision(tx, id, rep(), contentHash(action), { action: edited }));

    const seen: unknown[] = [];
    const runs = await Promise.all(Array.from({ length: 8 }, () =>
      withTenant(t.app, t.tenantA, sys, (tx) => executeApproved(tx, id, async (a) => { seen.push(a); return "ok"; }))));
    expect(runs.filter((r) => r.executed)).toHaveLength(1);
    expect(seen).toEqual([edited]);
  });

  it("a rejected decision cannot be executed and needs a reason", async () => {
    const id = await withTenant(t.app, t.tenantA, sys, newCard);
    await withTenant(t.app, t.tenantA, sys, (tx) => rejectDecision(tx, id, rep(), "competitor"));
    const r = await withTenant(t.app, t.tenantA, sys, (tx) => executeApproved(tx, id, async () => "never"));
    expect(r.executed).toBe(false);
    await expect(t.admin.query("UPDATE abcrm.decisions SET status = 'rejected', decided_by = $2, decided_at = now(), reject_reason_code = NULL WHERE id = $1",
      [id, repId])).rejects.toThrow(/check constraint/);
  });
});
