import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { approveDecision, contentHash, executeApproved, rejectDecision } from "@abcrm/agents";
import { activateSupplyProfile, getSupplyProfiles, returnSupplyToDraft, saveSupplyDraft, submitSupplyDraft, SupplyProfileInput } from "../src/index.js";

let t: TestDb;
const headId = randomUUID();
const head = () => ({ type: "user" as const, id: headId, role: "head_of_bd" as const });
const actor = { type: "user", id: headId } as const;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, actor, fn);

beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'h', 'h@a.vn', 'head_of_bd')", [headId, t.tenantA]);
});
afterAll(async () => { await t?.close(); });

const profile = (positioning: string) => SupplyProfileInput.parse({
  verticals: ["insurance"], positioning,
  lead_types: [{ vertical: "insurance", type: "aca_health", formats: ["data_lead"], delivery: ["ping_post"] }],
  compliance_assets: { trustedform: true, dnc_scrub: true },
});

async function approveAndActivate(decisionId: string) {
  return inA(async (tx) => {
    const { rows: [d] } = await tx.client.query("SELECT action FROM abcrm.decisions WHERE id = $1", [decisionId]);
    await approveDecision(tx, decisionId, head(), contentHash(d.action));
    return executeApproved(tx, decisionId, (a) => activateSupplyProfile(tx, actor, String(a.args.id), decisionId));
  });
}

describe("supply profile lifecycle (G-T1)", () => {
  it("validates input", () => {
    expect(() => SupplyProfileInput.parse({ verticals: ["insurance"], lead_types: [{ vertical: "legal", type: "mva", formats: ["data_lead"] }] }))
      .toThrow(/not in verticals/);
  });

  it("draft → submit → approve activates v1; v2 archives v1", async () => {
    await inA((tx) => saveSupplyDraft(tx, actor, profile("v1")));
    const { decisionId } = await inA((tx) => submitSupplyDraft(tx, actor));
    await expect(inA((tx) => saveSupplyDraft(tx, actor, profile("edit while pending")))).rejects.toThrow(/awaiting approval/);
    expect((await approveAndActivate(decisionId)).executed).toBe(true);
    expect((await inA(getSupplyProfiles)).active).toMatchObject({ version: 1, positioning: "v1", approved_decision_id: decisionId });

    await inA((tx) => saveSupplyDraft(tx, actor, profile("v2")));
    const second = await inA((tx) => submitSupplyDraft(tx, actor));
    await approveAndActivate(second.decisionId);
    const { active, draft } = await inA(getSupplyProfiles);
    expect(active).toMatchObject({ version: 2, positioning: "v2" });
    expect(draft).toBeNull();
    const { rows } = await t.admin.query("SELECT version, status FROM abcrm.supply_profiles WHERE tenant_id = $1 ORDER BY version", [t.tenantA]);
    expect(rows).toEqual([{ version: 1, status: "archived" }, { version: 2, status: "active" }]);
  });

  it("rejection returns the submission to draft and keeps the active version", async () => {
    await inA((tx) => saveSupplyDraft(tx, actor, profile("v3 rejected")));
    const { decisionId } = await inA((tx) => submitSupplyDraft(tx, actor));
    await inA(async (tx) => {
      await rejectDecision(tx, decisionId, head(), "other", "missing compliance pack");
      const { rows: [d] } = await tx.client.query("SELECT subject_id FROM abcrm.decisions WHERE id = $1", [decisionId]);
      await returnSupplyToDraft(tx, d.subject_id);
    });
    const { active, draft } = await inA(getSupplyProfiles);
    expect(active).toMatchObject({ version: 2 });
    expect(draft).toMatchObject({ status: "draft", positioning: "v3 rejected" });
  });
});
