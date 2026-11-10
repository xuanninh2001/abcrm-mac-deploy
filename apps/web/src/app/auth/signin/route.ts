import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { workos } from "@/lib/session";
import { safeNext } from "@/lib/paths";

/** Starts WorkOS AuthKit sign-in; `state` is bound to a short-lived cookie (CSRF on the callback). */
export async function GET(req: NextRequest) {
  const w = workos();
  if (!w || !config.workos) return NextResponse.redirect(new URL("/login?error=workos_not_configured", req.url));
  const state = randomBytes(16).toString("hex");
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const url = w.userManagement.getAuthorizationUrl({ provider: "authkit", clientId: config.workos.clientId, redirectUri: config.workos.redirectUri, state });
  const res = NextResponse.redirect(url);
  res.cookies.set("abcrm_oauth", JSON.stringify({ state, next }),
    { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/auth", maxAge: 600 });
  return res;
}
