import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { authOrigin, sameOrigin } from "@/lib/auth-origin";
import { readSession, SESSION_COOKIE } from "@/lib/session";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });
  const session = await readSession();
  if (session?.kind !== "local") return NextResponse.redirect(new URL("/login", authOrigin(req)), 303);
  const form = await req.formData();
  try {
    if (form.get("password") !== form.get("confirmation")) throw new Error("Mismatch");
    const result = await fetch(`${config.apiUrl}/auth/local/password`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ currentPassword: form.get("currentPassword"), password: form.get("password") }),
    });
    if (!result.ok) throw new Error("Rejected");
    const res = NextResponse.redirect(new URL("/login", authOrigin(req)), 303);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  } catch { return NextResponse.redirect(new URL("/password?error=failed", authOrigin(req)), 303); }
}
