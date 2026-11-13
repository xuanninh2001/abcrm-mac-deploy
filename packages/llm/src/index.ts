export * from "./types.js";
export { RouterGateway } from "./router.js";
export { settingsSchema, readLlmSettings, saveLlmSettings, prepareLlmSettings, tenantLlm } from "./settings.js";
export { AnthropicGateway, type AnthropicGatewayOptions } from "./anthropic.js";
export { ScriptedLlm, type ScriptedCall, type ScriptHandler } from "./scripted.js";
export { PLATFORM_RULES, untrusted } from "./prompt.js";
export { DEFAULT_MODELS, PRICES, costMicros, modelsFromEnv, type ModelPrice } from "./pricing.js";
export { recordCost, recordLlmCost, sumUsage, type CostKind } from "./ledger.js";

import { AnthropicGateway } from "./anthropic.js";
import type { LlmGateway } from "./types.js";

/** The configured gateway, or null when no Claude credentials are configured (agents then fall back or fail clearly). */
export function llmFromEnv(env = process.env): LlmGateway | null {
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return null;
  return new AnthropicGateway();
}
