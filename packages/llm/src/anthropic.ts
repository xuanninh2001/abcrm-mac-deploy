import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { costMicros, modelsFromEnv } from "./pricing.js";
import { LlmOutputError, type LlmGateway, type LlmRequest, type LlmResult, type Tier } from "./types.js";

const EFFORT: Record<Tier, "low" | "medium" | "high"> = { small: "low", medium: "medium", large: "high" };

export type AnthropicGatewayOptions = {
  client?: Anthropic;
  models?: Record<Tier, string>;
  /** Server-side refusal fallback for models that support it (Sonnet/Opus). Default on. */
  fallbacks?: boolean;
};

/**
 * LLM gateway on the Claude API (ADR-005). Output always goes through a Zod schema (structured outputs, validated again here);
 * the stable system layers are sent first with a cache breakpoint on the last one. The SDK retries 408/409/429/5xx.
 */
export class AnthropicGateway implements LlmGateway {
  private readonly client: Anthropic;
  private readonly models: Record<Tier, string>;
  private readonly fallbacks: boolean;

  constructor(opts: AnthropicGatewayOptions = {}) {
    this.client = opts.client ?? new Anthropic({ maxRetries: 3, timeout: 120_000 });
    this.models = opts.models ?? modelsFromEnv();
    this.fallbacks = opts.fallbacks ?? true;
  }

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const model = this.models[req.tier];
    const system = req.system.map((text, i) => ({
      type: "text" as const, text, ...(i === req.system.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const useFallback = this.fallbacks && !model.startsWith("claude-haiku");
    const response = await this.client.beta.messages.create({
      model,
      max_tokens: req.maxTokens ?? 4000,
      system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: EFFORT[req.tier], format: betaZodOutputFormat(req.schema as never) },
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    const u = response.usage;
    const usage = {
      model: response.model,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsdMicros: 0,
    };
    usage.costUsdMicros = costMicros(response.model, usage);

    if (response.stop_reason === "refusal") throw new LlmOutputError(`model declined (${response.stop_details?.category ?? "unspecified"})`, "refusal", usage);
    if (response.stop_reason === "max_tokens") throw new LlmOutputError("output truncated at max_tokens", "max_tokens", usage);
    // Parse ourselves (not messages.parse) so a bad output is a typed LlmOutputError, not an SDK parse error.
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new LlmOutputError("output is not JSON", "invalid_output", usage); }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new LlmOutputError(`output failed schema: ${parsed.error.message.slice(0, 300)}`, "invalid_output", usage);
    return { output: parsed.data, usage };
  }
}
