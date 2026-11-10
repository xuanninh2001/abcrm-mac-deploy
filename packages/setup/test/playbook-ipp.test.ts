import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { approveDecision, contentHash, executeApproved } from "@abcrm/agents";
import {
  activateIpp, activatePlaybook, cloneFromPack, expandPlaybookTemplate, lintPack, getPlaybook, IppInput, listPacks, loadPack, PlaybookInput,
  savePlaybookDraft, submitIpp, submitPlaybook,
} from "../src/index.js";

let t: TestDb;
const headId = randomUUID();
const actor = { type: "user", id: headId } as const;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, actor, fn);

beforeAll(async () => {
  t = await setupTestDb();
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'h', 'h@a.vn', 'head_of_bd')", [headId, t.tenantA]);
});
afterAll(async () => { await t?.close(); });

async function approve(decisionId: string, activate: (tx: TenantTx, id: string, d: string) => Promise<void>) {
  return inA(async (tx) => {
    const { rows: [d] } = await tx.client.query("SELECT action FROM abcrm.decisions WHERE id = $1", [decisionId]);
    await approveDecision(tx, decisionId, { type: "user", id: headId, role: "head_of_bd" }, contentHash(d.action));
    await executeApproved(tx, decisionId, (a) => activate(tx, String(a.args.id), decisionId));
  });
}

describe("vertical packs", () => {
  it("ships the three Phase 1 packs; runtime and spec copies are identical (no drift)", async () => {
    expect(await listPacks()).toEqual(["finance", "home_services", "insurance"]);
    for (const key of await listPacks()) {
      const runtime = await readFile(new URL(`../packs/${key}.yaml`, import.meta.url), "utf8");
      const spec = await readFile(new URL(`../../../docs/specs/phase-0-1/vertical-packs/${key}.yaml`, import.meta.url), "utf8");
      expect(runtime, key).toBe(spec);
    }
  });

  it("every pack passes lint: templates expand, lead types and playbooks resolve, W1 messaging is complete", async () => {
    for (const key of await listPacks()) expect(lintPack(await loadPack(key)), key).toEqual([]);
    const fin = await loadPack("finance");
    const loans = expandPlaybookTemplate(fin, "personal-loan-buyers", "Loans");
    expect(loans.vertical_pack).toBe("finance@1");
    expect(loans.criteria.reduce((s, c) => s + c.weight, 0)).toBe(100);
    expect(loans.criteria.find((c) => c.key === "states_licensed")?.description).toMatch(/NMLS/);
    const home = await loadPack("home_services");
    expect(expandPlaybookTemplate(home, "home-improvement-buyers", "Roofing").criteria.find((c) => c.key === "buys_matching_lead_types")?.description).toMatch(/roofing/);
    // Lint catches broken packs.
    const broken = { ...fin, ipp_templates: [{ ...fin.ipp_templates[0]!, lead_types: ["crypto"], playbook: "nope" }], messaging: { angles: ["x"], avoid: [], cta_options: ["Call me."] } };
    expect(lintPack(broken)).toEqual(expect.arrayContaining([
      expect.stringContaining("crypto is not in the taxonomy"), expect.stringContaining("playbook nope is missing"),
      "messaging.avoid is empty", "messaging.cta_options must be questions"]));
  });

  it("expands templates with extends/overrides into valid playbooks", async () => {
    expect(await listPacks()).toContain("insurance");
    const pack = await loadPack("insurance");
    const base = expandPlaybookTemplate(pack, "aca-fe-buyers", "ACA");
    expect(base.criteria).toHaveLength(11);
    expect(base.criteria.reduce((s, c) => s + c.weight, 0)).toBe(90);
    const medicare = expandPlaybookTemplate(pack, "medicare-buyers", "Medicare");
    expect(medicare.criteria.find((c) => c.key === "accepts_offshore_publishers")?.weight).toBe(30);
    expect(medicare.criteria.find((c) => c.key === "buys_matching_lead_types")?.description).toMatch(/Medicare/);
    expect(medicare.vertical_pack).toBe("insurance@1");
  });

  it("rejects unknown packs without path traversal", async () => {
    await expect(loadPack("../../etc/passwd")).rejects.toThrow(/not found/);
  });
});

describe("playbook validation", () => {
  const ok = { name: "P", criteria: [{ key: "k_one", name: "K", kind: "scored", evaluation: "ai_judged", weight: 10 }] };
  it("accepts a minimal playbook and enforces §3.2/§4 rules", () => {
    expect(PlaybookInput.parse(ok).tier_thresholds).toEqual({ A: 75, B: 55, C: 35 });
    const bad = (patch: object) => () => PlaybookInput.parse({ ...ok, ...patch });
    expect(bad({ criteria: [{ key: "k_one", name: "K", kind: "scored", evaluation: "ai_judged", weight: 0 }] })).toThrow(/need a weight/);
    expect(bad({ criteria: [{ key: "k_one", name: "K", kind: "knockout", evaluation: "rule", rule: { var: "contacts.email" } }] })).toThrow(/not allowed/);
    expect(bad({ criteria: [{ key: "k_one", name: "K", kind: "knockout", evaluation: "ai_judged" }] })).toThrow(/must_have or scored/);
    expect(bad({ tier_thresholds: { A: 50, B: 60, C: 10 } })).toThrow(/A > B > C/);
    expect(bad({ criteria: [ok.criteria[0], ok.criteria[0]] })).toThrow(/unique/);
  });
});

describe("playbook & IPP lifecycle", () => {
  it("clone → IPP cannot be submitted until its playbook is active → both activate via G-T1", async () => {
    const { playbook, ipp } = await inA((tx) => cloneFromPack(tx, actor, "insurance", "ACA & FE data-lead buyers"));
    expect(playbook.criteria).toHaveLength(11);
    expect(ipp).toMatchObject({ status: "draft", vertical: "insurance", playbook_id: playbook.id });
    expect(ipp.signals.tech).toContain("trustedform");

    await expect(inA((tx) => submitIpp(tx, actor, ipp.id))).rejects.toThrow(/playbook must be active/);
    const pb = await inA((tx) => submitPlaybook(tx, actor, playbook.id));
    await approve(pb.decisionId, (tx, id, d) => activatePlaybook(tx, actor, id, d));
    const ippSub = await inA((tx) => submitIpp(tx, actor, ipp.id));
    await approve(ippSub.decisionId, (tx, id, d) => activateIpp(tx, actor, id, d));

    const { rows } = await t.admin.query("SELECT status FROM abcrm.ipps WHERE id = $1 UNION ALL SELECT status FROM abcrm.playbooks WHERE id = $2", [ipp.id, playbook.id]);
    expect(rows.map((r) => r.status)).toEqual(["active", "active"]);
  });

  it("a new version of an active playbook is a separate draft; activating it archives v1; active criteria stay immutable", async () => {
    const pack = await loadPack("insurance");
    const v1 = await inA((tx) => savePlaybookDraft(tx, actor, expandPlaybookTemplate(pack, "aca-fe-buyers", "Lineage")));
    const s1 = await inA((tx) => submitPlaybook(tx, actor, v1.id));
    await approve(s1.decisionId, (tx, id, d) => activatePlaybook(tx, actor, id, d));
    await expect(inA((tx) => tx.client.query("DELETE FROM abcrm.criteria WHERE playbook_id = $1", [v1.id]))).rejects.toThrow(/immutable/);

    const edited = expandPlaybookTemplate(pack, "aca-fe-buyers", "Lineage v2");
    edited.criteria = edited.criteria.filter((c) => c.key !== "size_fit");
    const v2 = await inA((tx) => savePlaybookDraft(tx, actor, edited, v1.lineage_id));
    expect(v2).toMatchObject({ version: 2, status: "draft" });
    expect(v2.criteria).toHaveLength(10);
    expect(v2.definition_hash).not.toBe(v1.definition_hash);
    const s2 = await inA((tx) => submitPlaybook(tx, actor, v2.id));
    await approve(s2.decisionId, (tx, id, d) => activatePlaybook(tx, actor, id, d));
    expect((await inA((tx) => getPlaybook(tx, v1.id))).status).toBe("archived");
    expect((await inA((tx) => getPlaybook(tx, v2.id))).status).toBe("active");
  });

  it("IPP input normalizes exclusion domains and rejects junk", () => {
    const base = { name: "I", vertical: "insurance", lead_types: ["aca_health"], buyer_types: ["aggregator"], contact_titles: ["Affiliate Manager"], playbook_id: randomUUID() };
    expect(IppInput.parse({ ...base, exclusions: { domains: ["https://www.Rival.com/x", "rival.com"] } }).exclusions.domains).toEqual(["rival.com"]);
    expect(() => IppInput.parse({ ...base, exclusions: { domains: ["not a domain"] } })).toThrow(/invalid exclusion domain/);
  });
});
