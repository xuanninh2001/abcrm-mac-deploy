/** Fixed vendor endpoints only. Never surface upstream bodies or credential-bearing URLs in errors. */
export async function providerJson(url: string, init: RequestInit, label: string): Promise<unknown> {
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`${label} HTTP ${response.status}. Check API key, plan and quota.`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${label} returned an empty response.`);
    let length = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        length += value.length; if (length > 2 * 1024 * 1024) throw new Error(`${label} response too large.`); chunks.push(value);
      }
    } finally { await reader.cancel(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error(`${label} returned invalid JSON.`); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `)) throw error;
    throw new Error(`${label} connection failed or timed out.`);
  }
}
