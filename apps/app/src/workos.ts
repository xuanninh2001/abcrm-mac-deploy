import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type VerifiedSession = { orgId: string; userId: string; sessionId?: string };

export interface AccessTokenVerifier {
  /** Returns the session for a valid token, or null for any invalid/expired/foreign token. */
  verify(token: string): Promise<VerifiedSession | null>;
}

export type WorkosVerifierOptions = {
  clientId: string;
  /** Validated when set (WorkOS issuer depends on the auth domain configuration). */
  issuer?: string;
  /** Override for tests; defaults to the WorkOS JWKS for the client. */
  jwks?: JWTVerifyGetKey;
  clockToleranceSec?: number;
};

/**
 * Verifies WorkOS AuthKit access tokens (JWT, RS256) against WorkOS's public JWKS.
 * Identity is (org_id, sub); the role always comes from our database, never from the token.
 */
export function workosVerifier(opts: WorkosVerifierOptions): AccessTokenVerifier {
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${opts.clientId}`));
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ["RS256"],
          issuer: opts.issuer,
          clockTolerance: opts.clockToleranceSec ?? 5,
        });
        const orgId = typeof payload.org_id === "string" ? payload.org_id : undefined;
        if (!orgId || !payload.sub) return null;   // users must act inside an organization (= tenant)
        return { orgId, userId: payload.sub, sessionId: typeof payload.sid === "string" ? payload.sid : undefined };
      } catch {
        return null;
      }
    },
  };
}

/** The WorkOS User Management calls the API needs: invite emails and, on first sign-in, the user's verified email. */
export interface WorkosDirectory {
  /** The user's email when WorkOS reports it verified, else null. */
  verifiedEmail(userId: string): Promise<string | null>;
  /** Sends a WorkOS invitation email into the organization. */
  invite(input: { email: string; organizationId: string }): Promise<{ id: string }>;
}

/** REST adapter for WorkOS User Management (needs WORKOS_API_KEY). */
export function workosDirectory(apiKey: string, baseUrl = "https://api.workos.com"): WorkosDirectory {
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`WorkOS ${path} → ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  return {
    async verifiedEmail(userId) {
      const u = await call(`/user_management/users/${encodeURIComponent(userId)}`).catch(() => null);
      return u && u.email_verified === true && typeof u.email === "string" ? u.email.toLowerCase() : null;
    },
    async invite({ email, organizationId }) {
      const r = await call("/user_management/invitations", { method: "POST", body: JSON.stringify({ email, organization_id: organizationId }) });
      return { id: String(r.id) };
    },
  };
}
