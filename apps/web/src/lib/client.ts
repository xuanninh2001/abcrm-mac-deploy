"use client";

export type Problem = { title?: string; detail?: string; status?: number; issues?: { message: string }[] };

/** Browser → BFF (/api/v1) call. Mutations carry the CSRF header the BFF requires. */
export async function call<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json", "x-abcrm-csrf": "1" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    keepalive: init.keepalive,   // lets a pending decision finish while the page is closing
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error((data as Problem)?.title ?? `Error ${res.status}`), { problem: data as Problem, status: res.status });
  return data as T;
}

/** Multipart upload through the BFF (the browser sets the boundary). */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { method: "POST", headers: { "x-abcrm-csrf": "1" }, body: form });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error((data as Problem)?.title ?? `Error ${res.status}`), { problem: data as Problem, status: res.status });
  return data as T;
}

export const errorText = (e: unknown) => {
  const p = (e as { problem?: Problem }).problem;
  if (p?.issues?.length) return p.issues.map((i) => i.message).join("; ");
  return p?.detail ?? p?.title ?? (e as Error).message ?? "Something went wrong";
};
