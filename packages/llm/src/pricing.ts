import type { Tier } from "./types.js";

export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };   // USD per 1M tokens

/** Default tier → model map for the US cell. Override with ABCRM_LLM_MODEL_<TIER>. */
export const DEFAULT_MODELS: Record<Tier, string> = {
  small: "claude-haiku-5-5",
  medium: "claude-sonnet-5-5",
  large: "claude-opus-5-5",
};

/** First-party list prices; cache writes are billed at 1.25× input (5-minute TTL). */
export const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  "claude-opus-5-5": { input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 5.00 },
};

export function costMicros(model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const p = PRICES[model];
  if (!p) return 0;
  // USD per 1M tokens == micro-USD per token.
  return Math.round(u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite);
}

export function modelsFromEnv(env = process.env): Record<Tier, string> {
  return {
    small: env.ABCRM_LLM_MODEL_SMALL ?? DEFAULT_MODELS.small,
    medium: env.ABCRM_LLM_MODEL_MEDIUM ?? DEFAULT_MODELS.medium,
    large: env.ABCRM_LLM_MODEL_LARGE ?? DEFAULT_MODELS.large,
  };
}
