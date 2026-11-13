import type { TenantTx } from "@abcrm/db";
import type { TenantKeyring } from "./keyring.js";
import { Problem } from "./problem.js";

export const SOURCE_CATALOG = [
  { provider: "brave", kind: "search", name: "Brave Search" },
  { provider: "tavily", kind: "search", name: "Tavily Search" },
  { provider: "hunter", kind: "contact", name: "Hunter Domain Search" },
] as const;
export type SourceProvider = typeof SOURCE_CATALOG[number]["provider"];
export type SourceInput = { enabled: boolean; priority: number; apiKey?: string; clearKey: boolean; usageAllowed: boolean };
type Row = { provider: SourceProvider; enabled: boolean; priority: number; api_key_enc: Buffer | null; usage_allowed: boolean };
async function rows(tx: TenantTx) {
  return (await tx.client.query<Row>("SELECT provider, enabled, priority, api_key_enc, usage_allowed FROM abcrm.source_settings WHERE tenant_id=$1 ORDER BY priority, provider", [tx.tenantId])).rows;
}
export async function readSourceSettings(tx: TenantTx) {
  const saved = await rows(tx);
  return { sources: SOURCE_CATALOG.map(item => {
    const r = saved.find(s => s.provider === item.provider);
    return { ...item, configured: !!r, enabled: r?.enabled ?? false, priority: r?.priority ?? 10,
      hasApiKey: !!r?.api_key_enc, usageAllowed: r?.usage_allowed ?? false };
  }), environmentFallback: !saved.some(r => r.provider !== "hunter") };
}
export async function sourceCredential(tx: TenantTx, keyring: TenantKeyring, provider: SourceProvider, input: SourceInput) {
  if (input.apiKey && input.clearKey) throw new Problem("validation-failed", "Choose replace or remove key, not both.");
  if (input.apiKey && /[\r\n]/.test(input.apiKey)) throw new Problem("validation-failed", "API key must be one line.");
  const old = (await rows(tx)).find(r => r.provider === provider);
  return input.clearKey ? "" : input.apiKey || (old?.api_key_enc ? await keyring.decrypt(tx, `source_settings.${provider}`, old.api_key_enc) : "");
}
export async function saveSourceSettings(tx: TenantTx, keyring: TenantKeyring, provider: SourceProvider, input: SourceInput) {
  const key = await sourceCredential(tx, keyring, provider, input);
  if (input.enabled && !key) throw new Problem("validation-failed", "Enter an API key before enabling this source.");
  if (input.enabled && provider === "hunter" && !input.usageAllowed) throw new Problem("validation-failed", "Confirm your provider agreement permits this CRM use before enabling contacts.");
  await tx.client.query(`INSERT INTO abcrm.source_settings(tenant_id,provider,enabled,priority,api_key_enc,usage_allowed)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,provider) DO UPDATE SET enabled=EXCLUDED.enabled,
    priority=EXCLUDED.priority,api_key_enc=EXCLUDED.api_key_enc,usage_allowed=EXCLUDED.usage_allowed,updated_at=now()`,
  [tx.tenantId, provider, input.enabled, input.priority, key ? await keyring.encrypt(tx, `source_settings.${provider}`, key) : null, input.usageAllowed]);
  return readSourceSettings(tx);
}
export async function resolveSourceSettings(tx: TenantTx, keyring: TenantKeyring) {
  const saved = await rows(tx);
  const active = await Promise.all(saved.filter(r => r.enabled && r.api_key_enc).map(async r => ({
    provider: r.provider, priority: r.priority, usageAllowed: r.usage_allowed,
    apiKey: await keyring.decrypt(tx, `source_settings.${r.provider}`, r.api_key_enc!),
  })));
  return { active, searchConfigured: saved.some(r => r.provider !== "hunter") };
}
