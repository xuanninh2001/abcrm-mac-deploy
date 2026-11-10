import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor } from "@abcrm/db";

export type RequestContext = {
  requestId: string;
  tenantId: string;
  actor: Actor;
  role?: string;
  scopes?: string[];
};

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);

export function requestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error("no request context");
  return ctx;
}
