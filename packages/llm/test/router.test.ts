import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RouterGateway } from "../src/router.js";
import { normalizeRouterUrl, blockedRouterAddress } from "../src/router-http.js";

const options = { baseUrl: "https://router.example.com/v1", apiKey: "test-secret", model: "cc/claude-test", inputPrice: 2, outputPrice: 10, jsonMode: false };
const request = { tier: "medium" as const, purpose: "test", system: ["Rules", "Context"], user: "Decide", schema: z.object({ ok: z.boolean() }) };
const reply = (content: string, finish = "stop") => ({ model: "actual-fallback-model", choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });

describe("9router adapter", () => {
  it("uses chat completions and preserves prefixes, schemas and measured model", async () => {
    const transport = vi.fn().mockResolvedValue(reply('{"ok":true}'));
    const result = await new RouterGateway(options, transport).generate(request);
    expect(result.output).toEqual({ ok: true });
    expect(result.usage).toMatchObject({ model: "actual-fallback-model", inputTokens: 100, outputTokens: 20, costUsdMicros: 400 });
    const [url, key, path, body] = transport.mock.calls[0]!;
    expect([url, key, path]).toEqual([options.baseUrl, options.apiKey, "chat/completions"]);
    expect(body).toMatchObject({ model: options.model, stream: false });
    expect(body.messages[0].content).toContain('"required":["ok"]');
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("fallbacks");
    expect(body).not.toHaveProperty("response_format");
  });
  it("supports optional JSON mode and fenced JSON from translated providers", async () => {
    const transport = vi.fn().mockResolvedValue(reply('```json\n{"ok":true}\n```'));
    expect((await new RouterGateway({ ...options, jsonMode: true }, transport).generate(request)).output.ok).toBe(true);
    expect(transport.mock.calls[0]![3].response_format).toEqual({ type: "json_object" });
  });
  it.each([
    ["not JSON", "stop", "invalid_output"], ['{"ok":"yes"}', "stop", "invalid_output"],
    ['{"ok":true}', "length", "max_tokens"], ['{"ok":true}', "content_filter", "refusal"],
  ])("rejects unsafe/unusable completion: %s %s", async (text, finish, reason) => {
    await expect(new RouterGateway(options, async () => reply(text, finish)).generate(request)).rejects.toMatchObject({ reason });
  });
  it("loads model IDs and combo names without stripping prefixes", async () => {
    const transport = vi.fn().mockResolvedValue({ data: [{ id: "cc/claude-test" }, { id: "my-combo" }, { id: "my-combo" }] });
    expect(await new RouterGateway(options, transport).models()).toEqual(["cc/claude-test", "my-combo"]);
    expect(transport.mock.calls[0]![2]).toBe("models");
  });
  it("normalizes root, versioned and completion URLs", () => {
    for (const suffix of ["", "/", "/v1", "/v1/", "/v1/chat/completions", "/v1/models"]) {
      expect(normalizeRouterUrl(`https://router.example.com${suffix}`)).toBe(options.baseUrl);
    }
    expect(normalizeRouterUrl("https://router.example.com/proxy/v1")).toBe("https://router.example.com/proxy/v1");
  });
  it.each(["http://router.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://u:p@router.example.com", "https://router.example.com?token=secret"])("rejects unsafe URL %s", url => {
    expect(() => normalizeRouterUrl(url)).toThrow();
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.4", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1"])("blocks private DNS destination %s", ip => {
    expect(blockedRouterAddress(ip)).toBe(true);
  });
});
