import { providerJson } from "@abcrm/core";
import type { ContactProvider, ProviderPerson } from "./providers.js";

export class HunterContactProvider implements ContactProvider {
  readonly key = "hunter";
  constructor(private readonly apiKey: string) {}
  async test(): Promise<void> {
    const body = await providerJson(`https://api.hunter.io/v2/account?${new URLSearchParams({ api_key: this.apiKey })}`, {}, "Hunter") as { data?: { email?: unknown } };
    if (!body?.data || typeof body.data.email !== "string") throw new Error("Hunter returned an invalid account response.");
  }
  async find(domain: string, _titles: string[], limit: number) {
    const params = new URLSearchParams({ domain, api_key: this.apiKey, type: "personal", limit: String(Math.min(100, Math.max(10, limit * 5))) });
    const body = await providerJson(`https://api.hunter.io/v2/domain-search?${params}`, {}, "Hunter") as {
      data?: { emails?: { value?: string; first_name?: string; last_name?: string; position?: string; linkedin?: string; verification?: { status?: string } }[] };
    };
    if (!Array.isArray(body?.data?.emails)) throw new Error("Hunter returned an invalid contact list.");
    const people: ProviderPerson[] = body.data.emails
      .filter(p => p && p.verification?.status === "valid" && typeof p.value === "string" && typeof p.first_name === "string" && typeof p.last_name === "string" && typeof p.position === "string")
      .map(p => ({ firstName: p.first_name!, lastName: p.last_name!, title: p.position!, email: p.value!,
        ...(typeof p.linkedin === "string" && /^https:\/\/(www\.)?linkedin\.com\//i.test(p.linkedin) ? { linkedinUrl: p.linkedin } : {}), ref: `hunter:domain-search:${domain}` }));
    // Provider credits/subscriptions are reconciled in Hunter; do not invent a dollar price.
    return { people, costUsdMicros: 0 };
  }
}
