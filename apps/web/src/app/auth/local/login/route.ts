import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { authOrigin, sameOrigin } from "@/lib/auth-origin";
import { cookieOptions, sealSession, SESSION_COOKIE } from "@/lib/session";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });
  const form = await req.formData();
  const next = String(form.get("next") ?? "/inbox");
  const destination = new URL(next, authOrigin(req));
  if (destination.origin !== authOrigin(req)) return new NextResponse("Invalid redirect", { status: 400 });
  try {
    const response = await fetch(`${config.apiUrl}/auth/local/login`, {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ tenant: form.get("tenant"), email: form.get("email"), password: form.get("password") }),
    });
    if (response.ok) {
      const s = await response.json();
      if (!/^local_[a-f0-9]{64}$/.test(s.token) || typeof s.email !== "string" || !Number.isFinite(s.expiresAt)) throw new Error("Invalid session");
      const res = NextResponse.redirect(destination, 303);
      res.cookies.set(SESSION_COOKIE, sealSession({ kind: "local", token: s.token, email: s.email, expiresAt: s.expiresAt }), cookieOptions);
      return res;
    }
  } catch { /* Return a generic error without exposing credentials or backend details. */ }
  return NextResponse.redirect(new URL("/login?error=signin_failed", authOrigin(req)), 303);
}
