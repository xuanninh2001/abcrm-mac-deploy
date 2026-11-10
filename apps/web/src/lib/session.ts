import { cookies } from "next/headers";
import { WorkOS } from "@workos-inc/node";
import { config, sessionKey } from "./config";
import { jwtExp, seal, unseal } from "./seal";

export const SESSION_COOKIE = "abcrm_session";
const MAX_AGE = 60 * 60 * 24 * 14;

/** WorkOS AuthKit session (access + refresh token) or a dev token (`dev:<tenant>:<user>`, dev only). */
export type Session =
  | { kind: "workos"; accessToken: string; refreshToken: string; email: string; name: string | null }
  | { kind: "dev"; token: string; email: string };

export const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: MAX_AGE };

export const sealSession = (s: Session) => seal(sessionKey(), s);
export const unsealSession = (v: string | undefined) => unseal<Session>(sessionKey(), v);

export async function readSession(): Promise<Session | null> {
  return unsealSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export const workos = () => (config.workos ? new WorkOS(config.workos.apiKey, { clientId: config.workos.clientId }) : null);

/**
 * Returns a session whose access token is valid for at least a minute, refreshing a WorkOS session when needed.
 * `changed` tells the caller (proxy/route handler) to write the new cookie.
 */
export async function freshSession(s: Session | null): Promise<{ session: Session | null; changed: boolean }> {
  if (!s || s.kind === "dev") return { session: s, changed: false };
  const exp = jwtExp(s.accessToken);
  if (exp && exp * 1000 > Date.now() + 60_000) return { session: s, changed: false };
  const w = workos();
  if (!w || !config.workos) return { session: null, changed: true };
  try {
    const r = await w.userManagement.authenticateWithRefreshToken({ clientId: config.workos.clientId, refreshToken: s.refreshToken });
    return { session: { ...s, accessToken: r.accessToken, refreshToken: r.refreshToken }, changed: true };
  } catch {
    return { session: null, changed: true };
  }
}

export const bearer = (s: Session) => (s.kind === "dev" ? s.token : s.accessToken);
