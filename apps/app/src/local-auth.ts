import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "@abcrm/crypto";
import { Problem } from "@abcrm/core";
import type { AppEnv, Deps } from "./env.js";
import { RateLimiter, tooMany } from "./limits.js";

export const tokenHash = (token: string) => createHash("sha256").update(token).digest();
export function localAuthRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const attempts = new RateLimiter(5, 60_000), global = new RateLimiter(60, 60_000);
  r.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    const wait = global.hit("all");
    if (wait) { c.header("retry-after", String(wait)); throw tooMany(wait); }
    await next();
  });
  r.post("/login", async c => {
    const b = z.object({ tenant: z.string().trim().min(2).max(41), email: z.email().max(254).transform(s=>s.toLowerCase()), password: z.string().max(256) }).parse(await c.req.json());
    const wait = attempts.hit(`${b.tenant}:${b.email}`);
    if (wait) { c.header("retry-after", String(wait)); throw tooMany(wait); }
    const { rows: [user] } = await deps.pool.query("SELECT * FROM abcrm.local_login_user($1,$2)", [b.tenant,b.email]);
    const valid = await verifyPassword(b.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!user || !valid) throw new Problem("unauthenticated", "Invalid tenant, email or password");
    const token = `local_${randomBytes(32).toString("hex")}`;
    const { rows: [created] } = await deps.pool.query("SELECT abcrm.local_create_session($1,$2,$3) AS ok", [user.user_id,user.password_hash,tokenHash(token)]);
    if (!created.ok) throw new Problem("unauthenticated", "Invalid tenant, email or password");
    return c.json({ token, email: user.email, expiresAt: Date.now()+14*24*60*60*1000 });
  });
  r.post("/logout", async c => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    await deps.pool.query("SELECT abcrm.local_logout($1)", [tokenHash(token)]);
    return c.json({ ok: true });
  });
  r.post("/password", async c => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    const b = z.object({ currentPassword: z.string().max(256), password: z.string().min(12).max(256) }).parse(await c.req.json());
    const wait = attempts.hit(tokenHash(token).toString("hex"));
    if (wait) throw tooMany(wait);
    const { rows: [row] } = await deps.pool.query("SELECT abcrm.local_session_credential($1) AS hash", [tokenHash(token)]);
    if (!await verifyPassword(b.currentPassword, row?.hash ?? DUMMY_PASSWORD_HASH) || !row?.hash) throw new Problem("unauthenticated", "Current password is incorrect");
    if (Buffer.byteLength(b.password)>256) throw new Problem("validation-failed", "Password is too long");
    const { rows: [updated] } = await deps.pool.query("SELECT abcrm.local_change_password($1,$2,$3) AS ok", [tokenHash(token),row.hash,await hashPassword(b.password)]);
    if (!updated.ok) throw new Problem("unauthenticated", "Session changed; sign in again");
    return c.json({ ok: true });
  });
  return r;
}
