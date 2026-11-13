import { resolveSourceSettings, type TenantKeyring } from "@abcrm/core";
import { withTenant, type Pool } from "@abcrm/db";
import { BraveSearch, TavilySearch, SearchWaterfall, type SearchProvider } from "@abcrm/sourcing";
import { HunterContactProvider, type ContactDataDeps } from "@abcrm/contactdata";

export function workspaceSources(pool: Pool, keyring: TenantKeyring) {
  const load = (tenantId: string) => withTenant(pool, tenantId, { type: "system", id: "source-settings" }, tx => resolveSourceSettings(tx, keyring));
  return {
    async search(tenantId: string, environment: SearchProvider | null) {
      const config = await load(tenantId);
      if (!config.searchConfigured) return environment;
      const providers = config.active.flatMap<SearchProvider>(s => s.provider === "brave" ? [new BraveSearch(s.apiKey)] : s.provider === "tavily" ? [new TavilySearch(s.apiKey)] : []);
      return providers.length ? new SearchWaterfall(providers) : null;
    },
    async contacts(tenantId: string, base: ContactDataDeps): Promise<ContactDataDeps> {
      const config = await load(tenantId);
      const active = config.active.filter(s => s.provider === "hunter" && s.usageAllowed);
      return { ...base, providers: active.map(s => new HunterContactProvider(s.apiKey)),
        tenantProviders: active.map(s => ({ key: s.provider, priority: s.priority, allowed: s.usageAllowed })) };
    },
  };
}
