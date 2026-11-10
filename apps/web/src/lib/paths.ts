/** Only same-origin relative paths are allowed as post-login redirects (no `//host` or `/\host`). */
export function safeNext(v: string | null | undefined, fallback = "/inbox"): string {
  return v && /^\/(?![/\\])/.test(v) ? v : fallback;
}
