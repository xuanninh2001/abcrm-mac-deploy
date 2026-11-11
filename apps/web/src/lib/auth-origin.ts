import type { NextRequest } from "next/server";

// Configure the public origin explicitly behind a tunnel/reverse proxy.
export function authOrigin(req: NextRequest): string {
  return new URL(process.env.ABCRM_PUBLIC_URL ?? req.url).origin;
}
export function sameOrigin(req: NextRequest): boolean {
  return req.headers.get("origin") === authOrigin(req);
}
