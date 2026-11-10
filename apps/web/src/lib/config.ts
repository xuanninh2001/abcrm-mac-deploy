/** Server-side configuration of the web app. Nothing here is exposed to the browser. */
export const config = {
  apiUrl: (process.env.ABCRM_API_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  devAuth: process.env.ABCRM_DEV_AUTH === "1",
  workos: process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID
    ? { apiKey: process.env.WORKOS_API_KEY, clientId: process.env.WORKOS_CLIENT_ID, redirectUri: process.env.WORKOS_REDIRECT_URI ?? "http://localhost:3001/auth/callback" }
    : null,
};

export function sessionKey(): Buffer {
  const s = process.env.ABCRM_WEB_SESSION_SECRET;
  if (s) {
    const k = Buffer.from(s, "base64");
    if (k.length !== 32) throw new Error("ABCRM_WEB_SESSION_SECRET must be 32 bytes, base64");
    return k;
  }
  if (process.env.NODE_ENV === "production" && !devAuthEnabled()) throw new Error("ABCRM_WEB_SESSION_SECRET is required in production");
  return Buffer.alloc(32, 17);   // dev only
}

/** Dev sign-in: off in production builds unless ABCRM_WEB_ALLOW_DEV=1 (CI end-to-end tests only). */
export function devAuthEnabled(): boolean {
  return config.devAuth && (process.env.NODE_ENV !== "production" || process.env.ABCRM_WEB_ALLOW_DEV === "1");
}
