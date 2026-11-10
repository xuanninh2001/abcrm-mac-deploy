import type { z } from "zod";

/** Agents declare a tier, never a model (ADR-005). The gateway maps tiers to models per cell. */
export type Tier = "small" | "medium" | "large";

export interface LlmRequest<T> {
  tier: Tier;
  /** Stable label for metering and traces, e.g. "q1.judge". */
  purpose: string;
  /**
   * Stable prompt layers in cache order (agents.md §0): platform rules, template instructions,
   * pack/supply block, playbook block. The last one carries the cache breakpoint.
   */
  system: string[];
  /** Dynamic part: subject context and task. */
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicros: number;
}

export interface LlmResult<T> {
  output: T;
  usage: LlmUsage;
}

export interface LlmGateway {
  generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

/** The model declined or returned output that does not satisfy the schema. Not retried by the gateway; carries the usage that was still billed. */
export class LlmOutputError extends Error {
  constructor(message: string, readonly reason: "refusal" | "max_tokens" | "invalid_output", readonly usage?: LlmUsage) {
    super(message);
    this.name = "LlmOutputError";
  }
}
