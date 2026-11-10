import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { cookieOptions, sealSession, SESSION_COOKIE, workos } from "@/lib/session";
import { safeNext } from "@/lib/paths";

/** WorkOS AuthKit callback: code → access/refresh tokens. The API resolves the tenant and role from (org_id, user). */
export async function GET(req: NextRequest) {
  const w = workos();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  let saved: { state: string; next: string } | null = null;
  try { saved = JSON.parse(req.cookies.get("abcrm_oauth")?.value ?? "null"); } catch { saved = null; }
  if (!w || !config.workos || !code || !saved || saved.state !== state) return NextResponse.redirect(new URL("/login?error=signin_failed", req.url));
  try {
    const r = await w.userManagement.authenticateWithCode({ clientId: config.workos.clientId, code });
    const res = NextResponse.redirect(new URL(safeNext(saved.next), req.url));
    res.cookies.set(SESSION_COOKIE, sealSession({
      kind: "workos", accessToken: r.accessToken, refreshToken: r.refreshToken, email: r.user.email,
      name: [r.user.firstName, r.user.lastName].filter(Boolean).join(" ") || null,
    }), cookieOptions);
    res.cookies.delete("abcrm_oauth");
    return res;
  } catch {
    return NextResponse.redirect(new URL("/login?error=signin_failed", req.url));
  }
}
