import { LlmOutputError, type LlmGateway, type LlmRequest, type LlmResult } from "./types.js";

export type ScriptedCall = { purpose: string; tier: string; system: string[]; user: string };
export type ScriptHandler = (req: LlmRequest<unknown>) => unknown;

/**
 * Deterministic gateway for tests and offline dev: a handler per purpose produces the raw output, which is
 * validated against the request schema exactly like model output.
 */
export class ScriptedLlm implements LlmGateway {
  readonly calls: ScriptedCall[] = [];
  constructor(private readonly handlers: Record<string, ScriptHandler>, private readonly tokensPerCall = 1000) {}

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push({ purpose: req.purpose, tier: req.tier, system: req.system, user: req.user });
    const handler = this.handlers[req.purpose];
    if (!handler) throw new Error(`ScriptedLlm: no handler for ${req.purpose}`);
    const usage = { model: `scripted-${req.tier}`, inputTokens: this.tokensPerCall, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicros: 0 };
    const parsed = req.schema.safeParse(handler(req as LlmRequest<unknown>));
    if (!parsed.success) throw new LlmOutputError(`output failed schema: ${parsed.error.message}`, "invalid_output", usage);
    return { output: parsed.data, usage };
  }
}
