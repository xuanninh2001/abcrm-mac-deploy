import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, freshSession, sealSession, SESSION_COOKIE, unsealSession } from "./lib/session";

const PUBLIC = ["/login", "/auth/", "/dev-login"];

/**
 * Runs before every page and BFF call: no session → /login (pages) or 401 (API); an expiring WorkOS access token
 * is refreshed here so pages and the API proxy always see a valid one.
 */
export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (PUBLIC.some((p) => path === p || path.startsWith(p))) return NextResponse.next();
  const { session, changed } = await freshSession(unsealSession(req.cookies.get(SESSION_COOKIE)?.value));
  if (!session) {
    const res = path.startsWith("/api/")
      ? NextResponse.json({ type: "https://docs.abcrm.app/errors/unauthenticated", title: "Sign in required", status: 401 }, { status: 401 })
      : NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(path)}`, req.url));
    if (changed) res.cookies.delete(SESSION_COOKIE);
    return res;
  }
  if (!changed) return NextResponse.next();
  // Forward the refreshed cookie to this request's render and persist it in the browser.
  const value = sealSession(session);
  req.cookies.set(SESSION_COOKIE, value);
  const res = NextResponse.next({ request: { headers: req.headers } });
  res.cookies.set(SESSION_COOKIE, value, cookieOptions);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
