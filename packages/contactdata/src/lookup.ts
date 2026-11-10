import { withTenant, type Actor, type Pool, type TenantTx } from "@abcrm/db";
import { emit, notFound, recordUsage, releaseReservation, reserveCredits, uuidv7, type TenantKeyring } from "@abcrm/core";
import { normalizeEmail } from "@abcrm/crypto";
import { createContact, isSuppressed } from "@abcrm/crm";
import { recordCost } from "@abcrm/llm";
import { personKey, type PlatformKeys } from "./platform.js";
import type { ContactProvider, EmailVerifier, ProviderPerson } from "./providers.js";
import { matchTitle, normalizeTitle, rankScore, seniorityOf, titleGroups, type Seniority, type TitleMatch } from "./titles.js";

/** Contact Credits per returned contact (pricing doc §1.2): pay on result only. */
export const CONTACT_CREDITS = { valid: 1, catch_all: 0.5 } as const;

export type ContactDataDeps = {
  pool: Pool;
  /** abcrm_global connection: data_providers, licensed cache, global suppression. */
  global: Pool;
  keyring: TenantKeyring;
  platform: PlatformKeys;
  providers: ContactProvider[];
  verifier?: EmailVerifier;
};

export type FindInput = {
  /** Caller-chosen id makes the lookup idempotent (workflow retries return the stored result). */
  lookupId?: string;
  accountId: string;
  titles: string[];
  synonyms?: Record<string, string[]>;
  limit: number;
  candidateId?: string | null;
  /** Remaining Contact Credits the caller may spend (sourcing run budget); unlimited when absent. */
  creditBudget?: number;
  agentRunId?: string | null;
  sourcingRunId?: string | null;
};

export type FoundContact = {
  contactId: string; title: string; titleMatch: Exclude<TitleMatch, "none">; seniority: Seniority;
  emailStatus: "valid" | "catch_all"; linkedinUrl?: string; source: string; preselected: boolean; charged: number;
};
export type ProviderTry = { provider_key: string; hits: number; cache_hit: boolean; error?: string };
export type FindResult = { lookupId: string; contacts: FoundContact[]; contactCredits: number; providersTried: ProviderTry[]; reason?: string };

type ProviderRow = { id: string; key: string; priority: number; license: { resale_ok: boolean; cache_scope: "none" | "tenant" | "global"; ttl_days?: number } };
type Pick = { person: ProviderPerson; provider: string; match: Exclude<TitleMatch, "none">; seniority: Seniority };

/**
 * contact.find (system design §5.7): global suppression → licensed cache → provider waterfall → title match →
 * email verification → global suppression again → write to the tenant → charge per contact returned.
 */
export async function findContacts(deps: ContactDataDeps, tenantId: string, actor: Actor, input: FindInput): Promise<FindResult> {
  const lookupId = input.lookupId ?? uuidv7();
  const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(deps.pool, tenantId, actor, fn);
  const limit = Math.min(Math.max(input.limit, 1), 5);

  const start = await inTenant(async (tx) => {
    const { rows: [acc] } = await tx.client.query<{ domain: string }>("SELECT domain FROM abcrm.accounts WHERE id = $1", [input.accountId]);
    if (!acc) throw notFound("Account");
    const { rows: [prev] } = await tx.client.query<{ status: string; account_id: string; results: FoundContact[]; contact_credits: string; providers_tried: ProviderTry[] }>(
      "SELECT status, account_id, results, contact_credits, providers_tried FROM abcrm.contact_lookups WHERE id = $1", [lookupId]);
    if (prev && prev.account_id !== input.accountId) throw notFound("Contact lookup");
    if (prev?.status === "completed") {
      return { done: { lookupId, contacts: prev.results, contactCredits: Number(prev.contact_credits), providersTried: prev.providers_tried } satisfies FindResult };
    }
    if (!prev) {
      await tx.client.query(
        `INSERT INTO abcrm.contact_lookups(id, tenant_id, account_id, candidate_id, titles, limit_n, status) VALUES ($1, $2, $3, $4, $5, $6, 'running')`,
        [lookupId, tenantId, input.accountId, input.candidateId ?? null, input.titles, limit]);
    }
    // Reserve the most this lookup can cost (limit × 1 credit); the final transaction charges what was found and releases the rest.
    return { domain: acc.domain, credits: await reserveCredits(tx, "contact", limit * CONTACT_CREDITS.valid, `clookupres:${lookupId}`) };
  });
  if (start.done) return start.done;
  const domain = start.domain!;

  const costs: { kind: "contact_provider" | "email_verify"; vendor: string; units: number; micros: number }[] = [];
  const tried: ProviderTry[] = [];
  const groups = titleGroups(input.titles, input.synonyms);

  // 1–4. Global checks, cache and waterfall (no tenant attribution in the global space).
  const global = await deps.global.connect();
  let picks: Pick[] = [];
  let reason: string | undefined;
  try {
    const domainSuppressed = await global.query("SELECT 1 FROM abcrm.global_data_suppression WHERE kind = 'domain' AND value_ghmac = $1",
      [deps.platform.ghmac("domain", domain)]);
    const rows = domainSuppressed.rowCount ? [] : (await global.query<ProviderRow>(
      "SELECT id, key, priority, license FROM abcrm.data_providers WHERE kind = 'contact_finder' AND status = 'active' ORDER BY priority")).rows;
    if (domainSuppressed.rowCount) reason = "domain_suppressed";
    else if (!start.credits) { reason = "quota_exhausted"; rows.length = 0; }
    const adapters = new Map(deps.providers.map((p) => [p.key, p]));
    const usable = rows.filter((r) => r.license.resale_ok && adapters.has(r.key));
    if (!reason && !usable.length) reason = "no_providers";

    const seen = new Set<string>();
    for (const row of usable) {
      if (picks.filter((p) => p.match !== "weak").length >= limit) break;
      const adapter = adapters.get(row.key)!;
      const domainKey = deps.platform.ghmac("domain", domain);
      let people: ProviderPerson[] = [];
      let cacheHit = false;
      if (row.license.cache_scope === "global") {
        const cached = await global.query<{ payload_enc: Buffer }>(
          "SELECT payload_enc FROM abcrm.licensed_contact_cache WHERE provider_id = $1 AND company_domain_ghmac = $2 AND expires_at > now()", [row.id, domainKey]);
        people = cached.rows.map((r) => deps.platform.openCache<ProviderPerson>(row.key, r.payload_enc));
        cacheHit = people.length > 0;
      }
      if (!cacheHit) {
        try {
          const res = await adapter.find(domain, input.titles, limit);
          people = res.people;
          costs.push({ kind: "contact_provider", vendor: row.key, units: 1, micros: res.costUsdMicros });
        } catch (e) {
          tried.push({ provider_key: row.key, hits: 0, cache_hit: false, error: (e as Error).message.slice(0, 200) });
          continue;
        }
        if (row.license.cache_scope === "global" && people.length) {
          const ttl = row.license.ttl_days ?? 30;
          for (const p of people) {
            await global.query(
              `INSERT INTO abcrm.licensed_contact_cache(id, provider_id, company_domain_ghmac, person_key_ghmac, payload_enc, fetched_at, expires_at)
               VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(days => $6))
               ON CONFLICT (provider_id, person_key_ghmac) DO UPDATE SET payload_enc = EXCLUDED.payload_enc, fetched_at = now(), expires_at = EXCLUDED.expires_at`,
              [uuidv7(), row.id, domainKey, deps.platform.ghmac("person_key", personKey(p.firstName, p.lastName, domain)), deps.platform.sealCache(row.key, p), ttl]);
          }
        }
      }
      let hits = 0;
      for (const p of people) {
        let email: string;
        try { email = normalizeEmail(p.email); } catch { continue; }
        if (seen.has(email)) continue;
        const match = matchTitle(p.title, groups);
        if (match === "none") continue;
        seen.add(email);
        picks.push({ person: { ...p, email }, provider: row.key, match, seniority: seniorityOf(p.title) });
        hits++;
      }
      tried.push({ provider_key: row.key, hits, cache_hit: cacheHit });
    }

    // Opt-outs/deletions sent to ABCRM apply to every tenant (FR-S13).
    if (picks.length) {
      const sup = await global.query<{ value_ghmac: Buffer }>(
        "SELECT value_ghmac FROM abcrm.global_data_suppression WHERE (kind = 'email' AND value_ghmac = ANY($1)) OR (kind = 'person_key' AND value_ghmac = ANY($2))",
        [picks.map((p) => deps.platform.ghmac("email", p.person.email)),
          picks.map((p) => deps.platform.ghmac("person_key", personKey(p.person.firstName, p.person.lastName, domain)))]);
      const blocked = new Set(sup.rows.map((r) => r.value_ghmac.toString("hex")));
      picks = picks.filter((p) => !blocked.has(deps.platform.ghmac("email", p.person.email).toString("hex"))
        && !blocked.has(deps.platform.ghmac("person_key", personKey(p.person.firstName, p.person.lastName, domain)).toString("hex")));
    }
  } finally {
    global.release();
  }

  // 5. Verify the best title matches only (verification costs money).
  picks.sort((a, b) => rankScore(b.match, b.seniority, "valid") - rankScore(a.match, a.seniority, "valid"));
  const verified: (Pick & { emailStatus: "valid" | "catch_all" })[] = [];
  for (const p of picks.slice(0, limit * 2)) {
    if (!deps.verifier) { verified.push({ ...p, emailStatus: "valid" }); continue; }   // provider-verified data only (dev)
    const v = await deps.verifier.verify(p.person.email);
    costs.push({ kind: "email_verify", vendor: deps.verifier.key, units: 1, micros: v.costUsdMicros });
    if (v.result === "valid" || v.result === "catch_all") verified.push({ ...p, emailStatus: v.result });
  }
  verified.sort((a, b) => rankScore(b.match, b.seniority, b.emailStatus) - rankScore(a.match, a.seniority, a.emailStatus));

  // 6–8. Write into the tenant's space and charge per contact returned.
  return inTenant(async (tx) => {
    await releaseReservation(tx, `clookupres:${lookupId}`);
    const contacts: FoundContact[] = [];
    let credits = 0;
    for (const p of verified) {
      if (contacts.length >= limit) break;
      if (await isSuppressed(tx, deps.keyring, p.person.email)) continue;
      const price = CONTACT_CREDITS[p.emailStatus];
      const { contact, created } = await createContact(tx, deps.keyring, actor, input.accountId, {
        firstName: p.person.firstName, lastName: p.person.lastName, title: p.person.title, email: p.person.email, linkedinUrl: p.person.linkedinUrl ?? null,
        source: { kind: "provider", provider: p.provider, license_ref: p.person.ref ?? null, contact_lookup_id: lookupId },
      }, "return");
      if (contact.status !== "active" || contact.account_id !== input.accountId) continue;
      let charged = 0;
      if (created) {
        if (input.creditBudget !== undefined && credits + price > input.creditBudget) break;
        await tx.client.query(
          "UPDATE abcrm.contacts SET title_normalized = $2, seniority = $3, email_verification = $4 WHERE id = $1",
          [contact.id, normalizeTitle(p.person.title).replace(/ /g, "_"), p.seniority,
            { provider: deps.verifier?.key ?? p.provider, result: p.emailStatus, checked_at: new Date().toISOString() }]);
        const fresh = await recordUsage(tx, { idempotencyKey: `clookup:${lookupId}:${contact.id}`, meter: "contact", actionType: `contact_${p.emailStatus}`,
          credits: price, agentRunId: input.agentRunId, sourcingRunId: input.sourcingRunId });
        if (fresh) { charged = price; credits += price; }
      }
      contacts.push({ contactId: contact.id, title: p.person.title, titleMatch: p.match, seniority: p.seniority, emailStatus: p.emailStatus,
        linkedinUrl: p.person.linkedinUrl, source: p.provider, preselected: false, charged });
    }
    // Pre-select the top contact, or the top two when both are exact title matches.
    contacts.forEach((c, i) => { c.preselected = i === 0 || (i === 1 && contacts[0]!.titleMatch === "exact" && c.titleMatch === "exact"); });

    for (const c of costs) {
      await recordCost(tx, { kind: c.kind, vendor: c.vendor, units: c.units, costUsdMicros: c.micros, agentRunId: input.agentRunId, meterLink: `clookup:${lookupId}` });
    }
    await tx.client.query(
      `UPDATE abcrm.contact_lookups SET status = 'completed', providers_tried = $2, result_contact_ids = $3, contact_credits = $4, results = $5
       WHERE id = $1`, [lookupId, JSON.stringify(tried), contacts.map((c) => c.contactId), credits, JSON.stringify(contacts)]);
    await emit(tx, "contactdata.lookup.completed", {
      contact_lookup_id: lookupId, account_id: input.accountId, candidate_id: input.candidateId ?? null,
      found: contacts.length, verified: contacts.filter((c) => c.emailStatus === "valid").length, ...(reason ? { reason } : {}),
    });
    return { lookupId, contacts, contactCredits: credits, providersTried: tried, ...(reason ? { reason } : {}) };
  });
}

/** Records an opt-out/deletion received by ABCRM as data provider (privacy portal, FR-S13). */
export async function addGlobalSuppression(
  global: Pool, platform: PlatformKeys, s: { kind: "email" | "domain"; value: string; reason: "opt_out" | "deletion_request" | "legal"; source: string },
): Promise<void> {
  const normalized = s.kind === "email" ? normalizeEmail(s.value) : s.value.trim().toLowerCase();
  await global.query(
    `INSERT INTO abcrm.global_data_suppression(value_ghmac, kind, reason, requested_at, source) VALUES ($1, $2, $3, now(), $4) ON CONFLICT DO NOTHING`,
    [platform.ghmac(s.kind, normalized), s.kind, s.reason, s.source]);
  // Cached vendor records stay encrypted in the licensed cache but are filtered at every lookup (step 6).
  // Propagation to contacts already delivered to tenants (suppressed_by_source) needs a per-tenant sweep: Phase 2.
}
