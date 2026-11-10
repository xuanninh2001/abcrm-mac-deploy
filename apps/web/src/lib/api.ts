import "server-only";
import { redirect } from "next/navigation";
import { config } from "./config";
import { bearer, readSession } from "./session";

export class ApiError extends Error {
  constructor(readonly status: number, readonly problem: { title?: string; detail?: string; type?: string; issues?: unknown }) {
    super(problem.title ?? `API error ${status}`);
  }
}

/** Server-side call to the ABCRM API with the signed-in user's token (server components, server actions). */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const session = await readSession();
  if (!session) redirect("/login");
  const res = await fetch(`${config.apiUrl}/v1${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${bearer(session)}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 401) redirect("/login");
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data ?? {});
  return data as T;
}

export type Me = { tenant_id: string; role: string; actor: { id: string }; user?: { id: string; name: string | null; email: string; timezone: string; locale: string; working_hours: Record<string, [string, string]> } };
export const me = () => api<Me>("/me");
