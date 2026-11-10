import { type NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { bearer, readSession } from "@/lib/session";

/** Uploads (imports) are capped at 20 MB by the API; allow multipart overhead, refuse anything larger up front. */
const MAX_UPLOAD = 21 * 1024 * 1024;

/**
 * Backend-for-frontend: client components call /api/v1/* here; the request is forwarded to the API with the
 * session's token, so tokens never reach browser JavaScript. Mutations must carry `x-abcrm-csrf: 1`, which a
 * cross-site form or image cannot send (SameSite=Lax cookie + custom header).
 */
async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (req.method !== "GET" && req.headers.get("x-abcrm-csrf") !== "1") {
    return NextResponse.json({ title: "Missing CSRF header", status: 403 }, { status: 403 });
  }
  const session = await readSession();
  if (!session) return NextResponse.json({ title: "Sign in required", status: 401 }, { status: 401 });
  const { path } = await ctx.params;
  if (path.some((p) => p === ".." || p.includes("/"))) return NextResponse.json({ title: "Bad path", status: 400 }, { status: 400 });
  // JSON by default; multipart uploads pass through byte-for-byte with their boundary.
  const type = req.headers.get("content-type") ?? "";
  const multipart = type.startsWith("multipart/form-data");
  if (multipart && !(Number(req.headers.get("content-length")) <= MAX_UPLOAD)) {
    return NextResponse.json({ title: "Upload too large or missing Content-Length (max 20 MB)", status: 413 }, { status: 413 });
  }
  const url = `${config.apiUrl}/v1/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  const res = await fetch(url, {
    method: req.method,
    headers: {
      authorization: `Bearer ${bearer(session)}`, ...(req.method !== "GET" ? { "content-type": multipart ? type : "application/json" } : {}),
      // The API limits failed sign-ins per client address; pass the browser's, not this server's.
      ...(req.headers.get("x-forwarded-for") ? { "x-forwarded-for": req.headers.get("x-forwarded-for")! } : {}),
    },
    body: req.method === "GET" ? undefined : multipart ? await req.arrayBuffer() : await req.text(),
    cache: "no-store",
  });
  return new NextResponse(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
