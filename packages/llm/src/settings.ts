import { z } from "zod";
import { Problem, type TenantKeyring } from "@abcrm/core";
import type { TenantTx } from "@abcrm/db";
import { normalizeRouterUrl } from "./router-http.js";
import { RouterGateway, type RouterOptions } from "./router.js";
import { llmFromEnv } from "./index.js";

export const settingsSchema = z.object({
  mode: z.enum(["environment", "9router", "disabled"]),
  baseUrl: z.string().trim().max(2000), model: z.string().trim().max(200),
  apiKey: z.string().trim().max(4096).optional(),
  clearKey: z.boolean().default(false), jsonMode: z.boolean().default(false),
  inputPrice: z.number().min(0).max(10000).default(0), outputPrice: z.number().min(0).max(10000).default(0),
});
export type LlmSettingsInput = z.infer<typeof settingsSchema>;
type Row = { mode: LlmSettingsInput["mode"]; base_url: string; model: string; api_key_enc: Buffer | null;
  json_mode: boolean; input_price: string; output_price: string; updated_at: Date };
const column = "llm_settings.api_key";
async function row(tx: TenantTx): Promise<Row | undefined> {
  return (await tx.client.query<Row>("SELECT * FROM abcrm.llm_settings WHERE tenant_id = $1", [tx.tenantId])).rows[0];
}
export async function readLlmSettings(tx: TenantTx) {
  const r = await row(tx);
  return { mode: r?.mode ?? "environment", baseUrl: r?.base_url ?? "", model: r?.model ?? "", hasApiKey: !!r?.api_key_enc,
    jsonMode: r?.json_mode ?? false, inputPrice: Number(r?.input_price ?? 0), outputPrice: Number(r?.output_price ?? 0), updatedAt: r?.updated_at ?? null };
}

export async function prepareLlmSettings(tx: TenantTx, keyring: TenantKeyring, input: LlmSettingsInput) {
  const old = await row(tx);
  let baseUrl = input.baseUrl;
  if (baseUrl) {
    try { baseUrl = normalizeRouterUrl(baseUrl); }
    catch { throw new Problem("validation-failed", "Use a public HTTPS tunnel URL (root URL or /v1), without query parameters or credentials."); }
  }
  if (input.clearKey && input.apiKey) throw new Problem("validation-failed", "Choose either replace or remove the API key.");
  const changedHost = old?.base_url !== baseUrl;
  // Never forward a saved secret to a newly entered destination.
  const apiKey = input.clearKey ? "" : input.apiKey || (!changedHost && old?.api_key_enc ? await keyring.decrypt(tx, column, old.api_key_enc) : "");
  if (input.mode === "9router" && (!baseUrl || !input.model || !apiKey)) {
    throw new Problem("validation-failed", changedHost && old?.api_key_enc ? "Re-enter the API key when changing the tunnel URL." : "Tunnel URL, model and API key are required for 9router.");
  }
  if (/[\r\n]/.test(apiKey)) throw new Problem("validation-failed", "API key must be a single line.");
  return { ...input, baseUrl, apiKey };
}

export async function saveLlmSettings(tx: TenantTx, keyring: TenantKeyring, input: LlmSettingsInput) {
  const value = await prepareLlmSettings(tx, keyring, input);
  const encrypted = value.apiKey ? await keyring.encrypt(tx, column, value.apiKey) : null;
  await tx.client.query(`INSERT INTO abcrm.llm_settings(tenant_id, mode, base_url, model, api_key_enc, json_mode, input_price, output_price)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id) DO UPDATE SET mode=EXCLUDED.mode, base_url=EXCLUDED.base_url,
    model=EXCLUDED.model, api_key_enc=EXCLUDED.api_key_enc, json_mode=EXCLUDED.json_mode, input_price=EXCLUDED.input_price,
    output_price=EXCLUDED.output_price, updated_at=now()`,
  [tx.tenantId, value.mode, value.baseUrl, value.model, encrypted, value.jsonMode, value.inputPrice, value.outputPrice]);
  return readLlmSettings(tx);
}

export async function tenantLlm(tx: TenantTx, keyring: TenantKeyring) {
  const r = await row(tx);
  if (!r || r.mode === "environment") return llmFromEnv();
  if (r.mode === "disabled") return null;
  if (!r.api_key_enc) throw new Error("9router API key is missing.");
  const options: RouterOptions = { baseUrl: r.base_url, model: r.model, apiKey: await keyring.decrypt(tx, column, r.api_key_enc),
    jsonMode: r.json_mode, inputPrice: Number(r.input_price), outputPrice: Number(r.output_price) };
  return new RouterGateway(options);
}
