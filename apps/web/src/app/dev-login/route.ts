import { NextResponse, type NextRequest } from "next/server";
import { config, devAuthEnabled } from "@/lib/config";
import { cookieOptions, sealSession, SESSION_COOKIE } from "@/lib/session";
import { safeNext } from "@/lib/paths";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dev sign-in (local and CI only): the API must accept the dev token, which proves the tenant/user pair exists. */
export async function POST(req: NextRequest) {
  if (!devAuthEnabled()) return NextResponse.json({ title: "Not found", status: 404 }, { status: 404 });
  const form = await req.formData();
  const tenant = String(form.get("tenant_id") ?? "").trim();
  const user = String(form.get("user_id") ?? "").trim();
  if (!UUID.test(tenant) || !UUID.test(user)) return NextResponse.redirect(new URL("/login?error=invalid_ids", req.url), 303);
  const token = `dev:${tenant}:${user}`;
  const res = await fetch(`${config.apiUrl}/v1/me`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) return NextResponse.redirect(new URL("/login?error=unknown_user", req.url), 303);
  const me = (await res.json()) as { user?: { email: string } };
  const out = NextResponse.redirect(new URL(safeNext(String(form.get("next") ?? "")), req.url), 303);
  out.cookies.set(SESSION_COOKIE, sealSession({ kind: "dev", token, email: me.user?.email ?? user }), cookieOptions);
  return out;
}
