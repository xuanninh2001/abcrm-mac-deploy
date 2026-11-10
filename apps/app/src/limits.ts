import type { Context, MiddlewareHandler } from "hono";
import { Problem } from "@abcrm/core";
import type { AppEnv } from "./env.js";

/**
 * Fixed-window counters in process memory. Phase 1 runs one API instance; with several instances each one
 * limits on its own (move to Redis/Postgres when the API scales out).
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly max: number, private readonly windowMs = 60_000, private readonly now = () => Date.now()) {}

  /** Counts one hit; returns the seconds to wait when the key is over its limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 50_000) this.sweep(t);
    }
    w.count++;
    return w.count > this.max ? Math.ceil((w.start + this.windowMs - t) / 1000) : 0;
  }

  /** True when the key is already over the limit (without counting a hit). */
  blocked(key: string): number {
    const w = this.windows.get(key);
    const t = this.now();
    return w && t - w.start < this.windowMs && w.count >= this.max ? Math.ceil((w.start + this.windowMs - t) / 1000) : 0;
  }

  private sweep(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

export type Limits = { perActorPerMin: number; authFailuresPerIpPerMin: number };
export const DEFAULT_LIMITS: Limits = { perActorPerMin: 600, authFailuresPerIpPerMin: 30 };

/** Client address as seen by the platform proxy in front of the API (first X-Forwarded-For entry). */
export const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "direct";

export function tooMany(retryAfter: number): Problem {
  return new Problem("rate-limited", "Too many requests", { retry_after: retryAfter });
}

/** Per caller (user or API key) after authentication. */
export function actorLimit(limiter: RateLimiter): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { tenantId, actor } = c.get("ctx");
    const wait = limiter.hit(`${tenantId}:${actor.type}:${actor.id}`);
    if (wait) { c.header("retry-after", String(wait)); throw tooMany(wait); }
    await next();
  };
}
