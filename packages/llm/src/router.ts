import { z } from "zod";
import { LlmOutputError, type LlmGateway, type LlmRequest, type LlmResult } from "./types.js";
import { routerJson, type RouterTransport } from "./router-http.js";

export type RouterOptions = { baseUrl: string; apiKey: string; model: string; inputPrice: number; outputPrice: number; jsonMode: boolean };
const completion = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().nonnegative(), completion_tokens: z.number().nonnegative() }).optional(),
});

/** Portable chat completions: no Anthropic beta headers, effort or fallback parameters. */
export class RouterGateway implements LlmGateway {
  constructor(private readonly options: RouterOptions, private readonly transport: RouterTransport = routerJson) {}
  async models(): Promise<string[]> {
    const result = z.object({ data: z.array(z.object({ id: z.string().max(200) })).max(10000) }).safeParse(
      await this.transport(this.options.baseUrl, this.options.apiKey, "models"));
    if (!result.success) throw new Error("9router returned an invalid model list.");
    return [...new Set(result.data.data.map(m => m.id))].sort();
  }
  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const raw = await this.transport(this.options.baseUrl, this.options.apiKey, "chat/completions", {
      model: this.options.model, stream: false, max_tokens: req.maxTokens ?? 4000,
      messages: [
        { role: "system", content: [...req.system, `Return ONLY a JSON value matching this JSON schema. Do not include markdown or commentary.\n${JSON.stringify(z.toJSONSchema(req.schema))}`].join("\n\n") },
        { role: "user", content: req.user },
      ],
      ...(this.options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    });
    const parsed = completion.safeParse(raw);
    if (!parsed.success) throw new Error("9router returned an invalid chat completion.");
    const data = parsed.data;
    const choice = data.choices[0]!;
    const input = data.usage?.prompt_tokens ?? 0, output = data.usage?.completion_tokens ?? 0;
    const usage = { model: data.model ?? this.options.model, inputTokens: input, outputTokens: output,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicros: Math.round(input * this.options.inputPrice + output * this.options.outputPrice) };
    if (choice.message.refusal || choice.finish_reason === "content_filter") throw new LlmOutputError("Model declined the request", "refusal", usage);
    if (choice.finish_reason === "length") throw new LlmOutputError("Output truncated at max_tokens", "max_tokens", usage);
    let text = (choice.message.content ?? "").trim();
    // Some translated providers wrap an otherwise valid JSON answer in a code fence.
    if (/^```(?:json)?\s*\n[\s\S]*\n```$/i.test(text)) text = text.replace(/^```(?:json)?\s*\n/i, "").replace(/\n```$/, "");
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new LlmOutputError("Model output is not JSON", "invalid_output", usage); }
    const result = req.schema.safeParse(json);
    if (!result.success) throw new LlmOutputError("Model output does not match the required schema", "invalid_output", usage);
    return { output: result.data, usage };
  }
}
