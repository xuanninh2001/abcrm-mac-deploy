import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";
import { POST as login } from "../src/app/auth/local/login/route";
import { POST as logout } from "../src/app/auth/signout/route";
import { POST as password } from "../src/app/auth/local/password/route";
import { freshSession, sealSession, unsealSession, SESSION_COOKIE, type Session } from "../src/lib/session";

const cookie = vi.hoisted(()=>({value:undefined as string | undefined}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>cookie.value?{value:cookie.value}:undefined})}));
const origin="https://aurora.example.test";
const session: Session={kind:"local",token:`local_${"ab".repeat(32)}`,email:"owner@example.test",expiresAt:Date.now()+3600000};
beforeEach(()=>{
  vi.stubEnv("ABCRM_PUBLIC_URL",origin);
  vi.stubEnv("ABCRM_WEB_SESSION_SECRET",randomBytes(32).toString("base64"));
  cookie.value=undefined;
  vi.stubGlobal("fetch",vi.fn());
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
function request(path:string,data:Record<string,string>={},source:string=origin){
  return new NextRequest(`http://localhost:3001${path}`,{method:"POST",headers:{origin:source},body:new URLSearchParams(data)});
}
it("rejects foreign-origin login, password and logout before contacting API",async()=>{
  for(const handler of [login,password,logout]) expect((await handler(request("/auth/test",{},"https://foreign.test"))).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it("seals the token in an HttpOnly cookie and redirects using the public proxy origin",async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(session));
  const res=await login(request("/auth/local/login",{tenant:"abcrm",email:session.email,password:"test-long-password",next:"/inbox"}));
  expect(res.status).toBe(303);expect(res.headers.get("location")).toBe(`${origin}/inbox`);
  const stored=res.cookies.get(SESSION_COOKIE)!;
  expect(unsealSession(stored.value)).toEqual(session);
  expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  expect(res.headers.get("set-cookie")).toContain("SameSite=lax");
  expect(res.headers.get("set-cookie")).not.toContain(session.token);
});
it("blocks external redirects and returns generic errors on rejected credentials",async()=>{
  expect((await login(request("/auth/local/login",{next:"https://foreign.test"}))).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(new Response("Unauthorized",{status:401}));
  expect((await login(request("/auth/local/login"))).headers.get("location")).toBe(`${origin}/login?error=signin_failed`);
});
it("expires local cookies without calling WorkOS",async()=>{
  expect((await freshSession(session)).session).toEqual(session);
  expect(await freshSession({...session,expiresAt:1})).toEqual({session:null,changed:true});
  expect(fetch).not.toHaveBeenCalled();
});
it("redirects anonymous page requests to the public origin behind the tunnel",async()=>{
  const res=await proxy(new NextRequest("http://localhost:3001/inbox"));
  expect(res.headers.get("location")).toBe(`${origin}/login?next=%2Finbox`);
});
it("revokes API session before clearing the browser cookie and reports revocation failures",async()=>{
  cookie.value=sealSession(session);
  vi.mocked(fetch).mockRejectedValueOnce(new Error("Offline"));
  const failed=await logout(request("/auth/signout"));expect(failed.status).toBe(503);expect(failed.cookies.get(SESSION_COOKIE)).toBeUndefined();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ok:true}));
  const res=await logout(request("/auth/signout"));expect(res.status).toBe(303);
  expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("");
  expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining("/auth/local/logout"),expect.objectContaining({headers:{authorization:`Bearer ${session.token}`}}));
});
it("checks confirmation and clears cookie only after password change succeeds",async()=>{
  cookie.value=sealSession(session);
  const mismatch=await password(request("/auth/local/password",{password:"new-long-password",confirmation:"different"}));
  expect(mismatch.headers.get("location")).toBe(`${origin}/password?error=failed`);expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ok:true}));
  const res=await password(request("/auth/local/password",{currentPassword:"old-long-password",password:"new-long-password",confirmation:"new-long-password"}));
  expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("");expect(res.headers.get("location")).toBe(`${origin}/login`);
});
