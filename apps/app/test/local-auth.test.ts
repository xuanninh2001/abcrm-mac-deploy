import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { generateKey, LocalKeyProvider, hashPassword } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { withTenant, checkRlsCoverage } from "@abcrm/db";
import { setLocalPassword } from "../../../packages/db/src/local-password.js";
import { createApp } from "../src/app.js";
import { tokenHash } from "../src/local-auth.js";

let t: TestDb;
let app: ReturnType<typeof createApp>;
const uid = randomUUID(), password = "initial-local-password";
let hash: string;
beforeAll(async () => {
  t = await setupTestDb();
  hash = await hashPassword(password);
  await t.admin.query("UPDATE abcrm.tenants SET slug='local-auth-test' WHERE id=$1", [t.tenantA]);
  await t.admin.query("INSERT INTO abcrm.users(id,tenant_id,workos_user_id,email,role) VALUES($1,$2,$3,'owner@example.test','owner')", [uid,t.tenantA,`local:${uid}`]);
});
beforeEach(async () => {
  app = createApp({ pool:t.app, keyring:new TenantKeyring(new LocalKeyProvider(generateKey())),devAuth:false });
  await t.admin.query("UPDATE abcrm.tenants SET status='active' WHERE id=$1", [t.tenantA]);
  await t.admin.query("UPDATE abcrm.users SET status='active',role='owner' WHERE id=$1", [uid]);
  await setLocalPassword(t.admin,"local-auth-test","owner@example.test",hash);
});
afterAll(async () => { await t?.close(); });
const post = (path: string,body: unknown,token?: string) => app.request(path,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
const login = (overrides={}) => post("/auth/local/login",{tenant:"local-auth-test",email:"owner@example.test",password,...overrides});
const token = async () => {const r=await login(); expect(r.status).toBe(200);return (await r.json() as {token:string}).token;};
const me = (value:string) => app.request("/v1/me",{headers:{authorization:`Bearer ${value}`}});

it("authenticates against PostgreSQL and never stores a plaintext token",async()=>{
  const value=await token();
  expect(await (await me(value)).json()).toMatchObject({tenant_id:t.tenantA,role:"owner",actor:{id:uid}});
  const {rows:[s]}=await t.admin.query("SELECT token_hash FROM abcrm.local_sessions WHERE user_id=$1",[uid]);
  expect(s.token_hash.equals(tokenHash(value))).toBe(true);
  expect(await checkRlsCoverage(t.admin)).toEqual([]);
  await expect(t.app.query("SELECT * FROM abcrm.local_credentials")).rejects.toThrow();
  await expect(t.global.query("SELECT * FROM abcrm.local_sessions")).rejects.toThrow();
});
it("rejects incorrect credentials and a different workspace without leaking identity",async()=>{
  for(const overrides of [{password:"wrong"},{email:"missing@example.test"},{tenant:"other-workspace"}]) expect((await login(overrides)).status).toBe(401);
});
it("rate limits repeated password guesses",async()=>{
  for(let n=0;n<5;n++) expect((await login({password:"wrong"})).status).toBe(401);
  expect((await login()).status).toBe(429);
});
it("rejects expired and logged-out sessions",async()=>{
  let value=await token();
  await t.admin.query("UPDATE abcrm.local_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[uid]);
  expect((await me(value)).status).toBe(401);
  value=await token();
  expect((await post("/auth/local/logout",{},value)).status).toBe(200);
  expect((await me(value)).status).toBe(401);
});
it("disabling a user revokes sessions permanently even after re-enabling",async()=>{
  const value=await token();
  await t.admin.query("UPDATE abcrm.users SET status='disabled' WHERE id=$1",[uid]);
  expect((await login()).status).toBe(401);
  expect((await me(value)).status).toBe(401);
  await t.admin.query("UPDATE abcrm.users SET status='active' WHERE id=$1",[uid]);
  expect((await me(value)).status).toBe(401);
});
it("suspended tenants cannot sign in or use an existing session",async()=>{
  const value=await token();
  await t.admin.query("UPDATE abcrm.tenants SET status='suspended' WHERE id=$1",[t.tenantA]);
  expect((await login()).status).toBe(401);
  expect((await me(value)).status).toBe(401);
});
it("changes passwords and revokes all sessions; wrong current password cannot mutate",async()=>{
  const a=await token(),b=await token();
  expect((await post("/auth/local/password",{currentPassword:"wrong",password:"replacement-password"},a)).status).toBe(401);
  expect((await post("/auth/local/password",{currentPassword:password,password:"replacement-password"},a)).status).toBe(200);
  expect((await me(a)).status).toBe(401);expect((await me(b)).status).toBe(401);
  expect((await login()).status).toBe(401);
  expect((await login({password:"replacement-password"})).status).toBe(200);
});
it("administrator reset invalidates existing sessions without changing user roles",async()=>{
  const value=await token();
  await setLocalPassword(t.admin,"local-auth-test","owner@example.test",await hashPassword("reset-local-password"));
  expect((await me(value)).status).toBe(401);
  expect((await login({password:"reset-local-password"})).status).toBe(200);
});
it("owner creates an internal teammate; viewers cannot create users or access another tenant",async()=>{
  const value=await token(), email=`${randomUUID()}@example.test`;
  const res=await post("/v1/users",{email,role:"viewer",password},value);
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({user:{status:"active"},invitation:{reason:"local_account_created"}});
  const signed=await login({email});expect(signed.status).toBe(200);
  const viewer=(await signed.json() as {token:string}).token;
  expect((await post("/v1/users",{email:"other@example.test",role:"owner",password},viewer)).status).toBe(403);
  const foreign=randomUUID();
  await t.admin.query("INSERT INTO abcrm.users(id,tenant_id,workos_user_id,email,role,status) VALUES($1,$2,$3,'foreign@example.test','viewer','invited')",[foreign,t.tenantB,`invite:${foreign}`]);
  await expect(withTenant(t.app,t.tenantA,{type:"user",id:uid},tx=>tx.client.query("SELECT abcrm.local_initialize_user($1,$2)",[foreign,hash]))).rejects.toThrow();
});
