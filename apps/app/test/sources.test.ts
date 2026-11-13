import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { TenantKeyring, resolveSourceSettings } from "@abcrm/core";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { withTenant, checkRlsCoverage } from "@abcrm/db";
import { createApp } from "../src/app.js";
let db: TestDb, app: ReturnType<typeof createApp>, keyring: TenantKeyring;
const owner = randomUUID(), admin = randomUUID(), other = randomUUID();
let ownerToken: string, adminToken: string, otherToken: string;
const input = { enabled: true, priority: 5, apiKey: "source-test-secret", usageAllowed: false };
beforeAll(async () => {
  db = await setupTestDb(); keyring = new TenantKeyring(new LocalKeyProvider(generateKey())); app = createApp({ pool: db.app, keyring, devAuth: true });
  for (const [id, tenant, role] of [[owner, db.tenantA, "owner"], [admin, db.tenantA, "admin"], [other, db.tenantB, "owner"]]) {
    await db.admin.query("INSERT INTO abcrm.users(id,tenant_id,workos_user_id,email,role) VALUES($1,$2,$3,$4,$5)", [id,tenant,`test:${id}`,`${id}@example.com`,role]);
  }
  ownerToken=`dev:${db.tenantA}:${owner}`; adminToken=`dev:${db.tenantA}:${admin}`; otherToken=`dev:${db.tenantB}:${other}`;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await db?.close(); });
const call = (method: string, token: string, suffix = "", body?: unknown) => app.request(`/v1/sources${suffix}`, { method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
it("requires owner for read/save/probe and rejects unknown providers", async () => {
  for (const [method,path] of [["GET",""],["PUT","/brave"],["POST","/brave/test"]]) expect((await call(method!,adminToken,path,method === "GET" ? undefined : input)).status).toBe(403);
  expect((await call("PUT",ownerToken,"/unknown",input)).status).toBe(422);
});
it("encrypts keys, preserves blank keys and isolates workspaces", async () => {
  const response = await call("PUT",ownerToken,"/brave",input);
  expect(response.status).toBe(200); expect(await response.text()).not.toContain(input.apiKey);
  const stored = (await db.admin.query("SELECT api_key_enc FROM abcrm.source_settings WHERE tenant_id=$1",[db.tenantA])).rows[0].api_key_enc as Buffer;
  expect(stored.toString()).not.toContain(input.apiKey);
  expect((await call("PUT",ownerToken,"/brave",{...input,apiKey:""})).status).toBe(200);
  const active = await withTenant(db.app,db.tenantA,{type:"user",id:owner},tx=>resolveSourceSettings(tx,keyring));
  expect(active.active[0]?.apiKey).toBe(input.apiKey);
  const otherData = await (await call("GET",otherToken)).json() as { sources: { hasApiKey: boolean }[] };
  expect(otherData.sources.every((s: {hasApiKey: boolean})=>!s.hasApiKey)).toBe(true);
  expect(await checkRlsCoverage(db.admin)).toEqual([]);
});
it("tests unsaved keys without importing contacts or saving state", async () => {
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{email:"owner@example.com"}}))));
  expect((await call("POST",ownerToken,"/hunter/test",input)).status).toBe(200);
  const data = await (await call("GET",ownerToken)).json() as { sources: { provider: string; configured: boolean }[] };
  expect(data.sources.find((s:{provider:string})=>s.provider === "hunter")!.configured).toBe(false);
  expect((await db.admin.query("SELECT count(*)::int AS n FROM abcrm.contacts")).rows[0].n).toBe(0);
});
it("enforces contact consent and disabling does not restore environment fallback", async () => {
  expect((await call("PUT",ownerToken,"/hunter",input)).status).toBe(422);
  expect((await call("PUT",ownerToken,"/hunter",{...input,usageAllowed:true})).status).toBe(200);
  const res=await call("PUT",ownerToken,"/brave",{...input,enabled:false,apiKey:"",clearKey:true});
  expect(res.status).toBe(200); expect(((await res.json()) as { environmentFallback: boolean }).environmentFallback).toBe(false);
  const active=await withTenant(db.app,db.tenantA,{type:"user",id:owner},tx=>resolveSourceSettings(tx,keyring));
  expect(active.searchConfigured).toBe(true); expect(active.active.map(s=>s.provider)).toEqual(["hunter"]);
});
