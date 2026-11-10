import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type KeyLike } from "jose";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { createApp } from "../src/app.js";
import { workosVerifier } from "../src/workos.js";

const ISSUER = "https://auth.abcrm.test";
let t: TestDb;
let app: ReturnType<typeof createApp>;
let signingKey: KeyLike;
let otherKey: KeyLike;
const userA = randomUUID();

const sign = (claims: JWTPayload, opts: { key?: KeyLike; exp?: string; iss?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuedAt()
    .setIssuer(opts.iss ?? ISSUER).setExpirationTime(opts.exp ?? "5m").sign(opts.key ?? signingKey);

beforeAll(async () => {
  t = await setupTestDb();
  const kp = await generateKeyPair("RS256");
  signingKey = kp.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" }] });
  await t.admin.query("UPDATE abcrm.tenants SET workos_org_id = 'org_A' WHERE id = $1", [t.tenantA]);
  await t.admin.query("UPDATE abcrm.tenants SET workos_org_id = 'org_B' WHERE id = $1", [t.tenantB]);
  await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'user_01A', 'hd@agency.vn', 'head_of_bd')", [userA, t.tenantA]);
  app = createApp({
    pool: t.app, keyring: new TenantKeyring(new LocalKeyProvider(generateKey())), devAuth: false,
    verifier: workosVerifier({ clientId: "client_test", issuer: ISSUER, jwks }),
  });
});
afterAll(async () => { await t?.close(); });

const me = (token: string) => app.request("/v1/me", { headers: { authorization: `Bearer ${token}` } });

describe("WorkOS access tokens", () => {
  it("maps (org_id, sub) to the tenant user; role comes from the database", async () => {
    const res = await me(await sign({ sub: "user_01A", org_id: "org_A", role: "owner", sid: "session_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenant_id: t.tenantA, actor: { type: "user", id: userA }, role: "head_of_bd" });
  });

  it("rejects expired, wrong-issuer, foreign-key and org-less tokens", async () => {
    const bad = [
      await sign({ sub: "user_01A", org_id: "org_A" }, { exp: "-1m" }),
      await sign({ sub: "user_01A", org_id: "org_A" }, { iss: "https://evil.test" }),
      await sign({ sub: "user_01A", org_id: "org_A" }, { key: otherKey }),
      await sign({ sub: "user_01A" }),
    ];
    for (const token of bad) expect((await me(token)).status).toBe(401);
  });

  it("a user of org A presenting org B is refused (no cross-tenant identity)", async () => {
    expect((await me(await sign({ sub: "user_01A", org_id: "org_B" }))).status).toBe(401);
  });

  it("disabled users are refused", async () => {
    await t.admin.query("UPDATE abcrm.users SET status = 'disabled' WHERE id = $1", [userA]);
    expect((await me(await sign({ sub: "user_01A", org_id: "org_A" }))).status).toBe(401);
    await t.admin.query("UPDATE abcrm.users SET status = 'active' WHERE id = $1", [userA]);
  });
});

describe("first sign-in of an invited user", () => {
  const emails: Record<string, string | null> = { user_new: "New.Rep@agency.vn", user_unverified: null, user_twin: "new.rep@agency.vn", user_b: "b.rep@agency.vn" };
  let invited: string;
  let withDirectory: ReturnType<typeof createApp>;

  beforeAll(async () => {
    invited = randomUUID();
    await t.admin.query(
      "INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role, status, invited_by) VALUES ($1, $2, $3, 'new.rep@agency.vn', 'sales_rep', 'invited', $4)",
      [invited, t.tenantA, `invite:${invited}`, userA]);
    await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, 'b.rep@agency.vn', 'sales_rep', 'invited')",
      [randomUUID(), t.tenantB, `invite:b`]);
    const kp = await generateKeyPair("RS256");
    signingKey = kp.privateKey;
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" }] });
    withDirectory = createApp({
      pool: t.app, keyring: new TenantKeyring(new LocalKeyProvider(generateKey())), devAuth: false,
      verifier: workosVerifier({ clientId: "client_test", issuer: ISSUER, jwks }),
      directory: { verifiedEmail: async (id) => emails[id]?.toLowerCase() ?? null, invite: async () => ({ id: "inv_1" }) },
    });
  });
  const meWith = (token: string) => withDirectory.request("/v1/me", { headers: { authorization: `Bearer ${token}` } });

  it("an unverified email or another organization's invite does not activate", async () => {
    expect((await meWith(await sign({ sub: "user_unverified", org_id: "org_A" }))).status).toBe(401);
    expect((await meWith(await sign({ sub: "user_b", org_id: "org_A" }))).status).toBe(401);   // b's invite lives in org_B
  });

  it("binds the WorkOS identity to the invite with the same verified email, once", async () => {
    const res = await meWith(await sign({ sub: "user_new", org_id: "org_A" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenant_id: t.tenantA, actor: { id: invited }, role: "sales_rep" });
    const row = await t.admin.query("SELECT workos_user_id, status, activated_at IS NOT NULL AS activated FROM abcrm.users WHERE id = $1", [invited]);
    expect(row.rows[0]).toEqual({ workos_user_id: "user_new", status: "active", activated: true });
    const n = await t.admin.query("SELECT kind FROM abcrm.notifications WHERE user_id = $1", [userA]);
    expect(n.rows.map((r) => r.kind)).toContain("user_activated");
    expect((await t.admin.query("SELECT count(*)::int AS n FROM abcrm.outbox WHERE topic = 'iam.user.activated'")).rows[0].n).toBe(1);
    // Another WorkOS user with the same email cannot take the seat over.
    expect((await meWith(await sign({ sub: "user_twin", org_id: "org_A" }))).status).toBe(401);
    expect((await meWith(await sign({ sub: "user_new", org_id: "org_A" }))).status).toBe(200);
  });
});
