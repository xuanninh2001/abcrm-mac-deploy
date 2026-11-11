import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSession } from "@/lib/session";
import { config } from "@/lib/config";
import { authOrigin, sameOrigin } from "@/lib/auth-origin";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });
  const session = await readSession();
  if (session?.kind === "local") {
    try {
      const result = await fetch(`${config.apiUrl}/auth/local/logout`, { method: "POST", headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(10_000) });
      if (!result.ok) throw new Error("Logout failed");
    } catch { return new NextResponse("Unable to revoke session. Please retry sign out.", { status: 503 }); }
  }
  const res = NextResponse.redirect(new URL("/login", authOrigin(req)), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
