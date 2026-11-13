import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { TenantKeyring } from "@abcrm/core";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { withTenant, checkRlsCoverage } from "@abcrm/db";
import { tenantLlm, RouterGateway } from "@abcrm/llm";
import { createApp } from "../src/app.js";

const transport = vi.hoisted(() => vi.fn());
vi.mock("../../../packages/llm/src/router-http.js", async importOriginal => ({
  ...await importOriginal<object>(), routerJson: transport,
}));

let db: TestDb, app: ReturnType<typeof createApp>, keyring: TenantKeyring;
const owner = randomUUID(), viewer = randomUUID(), other = randomUUID();
let ownerToken: string, viewerToken: string, otherToken: string;
const input = { mode: "9router", baseUrl: "https://router.example.com", model: "cc/claude-test", apiKey: "key-only-for-testing", inputPrice: 2, outputPrice: 10 };
beforeAll(async () => {
  db = await setupTestDb(); keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));
  app = createApp({ pool: db.app, keyring, devAuth: true });
  for (const [id, tenant, role] of [[owner, db.tenantA, "owner"], [viewer, db.tenantA, "admin"], [other, db.tenantB, "owner"]]) {
    await db.admin.query("INSERT INTO abcrm.users(id,tenant_id,workos_user_id,email,role) VALUES($1,$2,$5,$3,$4)", [id, tenant, `${id}@example.com`, role, `test:${id}`]);
  }
  ownerToken = `dev:${db.tenantA}:${owner}`; viewerToken = `dev:${db.tenantA}:${viewer}`; otherToken = `dev:${db.tenantB}:${other}`;
});
afterAll(async () => { await db?.close(); });
const call = (method: string, token: string, body?: unknown, suffix = "") => app.request(`/v1/llm-settings${suffix}`, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});
describe("workspace LLM settings", () => {
  it("enforces owner-only access for reading, writing and connection probes", async () => {
    for (const [method, suffix] of [["GET", ""], ["PUT", ""], ["POST", "/models"], ["POST", "/test"]]) {
      expect((await call(method!, viewerToken, method === "GET" ? undefined : input, suffix)).status).toBe(403);
    }
  });
  it("encrypts credentials and returns only the presence indicator", async () => {
    const res = await call("PUT", ownerToken, input);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ hasApiKey: true, baseUrl: "https://router.example.com/v1", model: input.model });
    expect(JSON.stringify(body)).not.toContain(input.apiKey);
    const stored = (await db.admin.query("SELECT api_key_enc FROM abcrm.llm_settings WHERE tenant_id=$1", [db.tenantA])).rows[0].api_key_enc as Buffer;
    expect(stored.toString()).not.toContain(input.apiKey);
    const gateway = await withTenant(db.app, db.tenantA, { type: "user", id: owner }, tx => tenantLlm(tx, keyring));
    expect(gateway).toBeInstanceOf(RouterGateway);
    expect(await checkRlsCoverage(db.admin)).toEqual([]);
  });
  it("preserves saved key, isolates tenants, rejects moving a key to a new URL", async () => {
    expect((await call("PUT", ownerToken, { ...input, apiKey: "", model: "my-combo" })).status).toBe(200);
    expect(await (await call("GET", otherToken)).json()).toMatchObject({ hasApiKey: false, mode: "environment" });
    expect((await call("PUT", ownerToken, { ...input, apiKey: "", baseUrl: "https://another.example.com" })).status).toBe(422);
    const foreign = await withTenant(db.app, db.tenantB, { type: "user", id: other }, tx => tx.client.query("SELECT * FROM abcrm.llm_settings"));
    expect(foreign.rows).toEqual([]);
  });
  it("applies disabled mode and removes the stored key", async () => {
    expect((await call("PUT", ownerToken, { ...input, mode: "disabled", apiKey: "", clearKey: true })).status).toBe(200);
    expect(await (await call("GET", ownerToken)).json()).toMatchObject({ mode: "disabled", hasApiKey: false });
    expect(await withTenant(db.app, db.tenantA, { type: "user", id: owner }, tx => tenantLlm(tx, keyring))).toBeNull();
  });
  it("tests unsaved credentials with the same gateway and does not persist them", async () => {
    transport.mockResolvedValueOnce({ data: [{ id: "cc/model" }, { id: "combo" }] });
    const models = await call("POST", ownerToken, { ...input, model: "" }, "/models");
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ models: ["cc/model", "combo"] });
    transport.mockResolvedValueOnce({ model: "cc/model", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const probe = await call("POST", ownerToken, input, "/test");
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ ok: true, model: "cc/model" });
    expect(await (await call("GET", ownerToken)).json()).toMatchObject({ mode: "disabled", hasApiKey: false });
    transport.mockRejectedValueOnce(new Error("9router HTTP 401. Check API key and tunnel access rules."));
    const denied = await call("POST", ownerToken, input, "/test");
    expect(denied.status).toBe(422);
    expect(await denied.text()).not.toContain(input.apiKey);
  });
});
