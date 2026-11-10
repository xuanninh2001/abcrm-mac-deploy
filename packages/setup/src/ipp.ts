import { z } from "zod";
import type { Actor, TenantTx } from "@abcrm/db";
import { notFound, Problem, uuidv7 } from "@abcrm/core";
import { normalizeDomain } from "@abcrm/crypto";
import { activateVersion, draftInLineage, nextVersion, returnVersionToDraft, submitVersion } from "./versioned.js";

export const BUYER_TYPES = ["direct_brand", "aggregator", "affiliate_network", "ping_post_exchange", "call_buyer"] as const;
export const VERTICALS = ["insurance", "finance", "home_services", "education", "legal"] as const;

/** Ideal Partner Profile (ipp-playbook-format.md §2). */
export const IppInput = z.object({
  name: z.string().min(1).max(120),
  vertical: z.enum(VERTICALS),
  lead_types: z.array(z.string().regex(/^[a-z0-9_]{2,40}$/)).min(1).max(20),
  buyer_types: z.array(z.enum(BUYER_TYPES)).min(1),
  purchase_formats: z.array(z.enum(["data_lead", "live_transfer", "inbound_call", "appointment"])).min(1).default(["data_lead"]),
  payout_models: z.array(z.enum(["cpl", "cpa", "ppc", "rev_share"])).min(1).default(["cpl"]),
  size: z.object({ employees_min: z.number().int().nonnegative().optional(), employees_max: z.number().int().positive().optional() }).default({}),
  signals: z.object({
    web_paths: z.array(z.string().regex(/^\/[\w\-/]*$/)).max(20).default([]),
    tech: z.array(z.string().max(30)).max(20).default([]),
    text: z.array(z.string().min(3).max(80)).max(30).default([]),
  }).default({ web_paths: [], tech: [], text: [] }),
  exclusions: z.object({
    domains: z.array(z.string()).max(500).default([]),
    keywords: z.array(z.string().min(3).max(80)).max(30).default([]),
    buyer_types: z.array(z.enum(BUYER_TYPES)).default([]),
  }).default({ domains: [], keywords: [], buyer_types: [] }),
  contact_titles: z.array(z.string().min(2).max(80)).min(1).max(20),
  contacts_per_account: z.number().int().min(1).max(5).default(2),
  playbook_id: z.uuid(),
}).transform((v, ctx) => {
  const domains: string[] = [];
  for (const d of v.exclusions.domains) {
    try { domains.push(normalizeDomain(d)); } catch { ctx.addIssue({ code: "custom", message: `invalid exclusion domain: ${d}` }); }
  }
  return { ...v, exclusions: { ...v.exclusions, domains: [...new Set(domains)] } };
});
export type IppInput = z.output<typeof IppInput>;

const COLS = `id, lineage_id, name, version, status, vertical, lead_types, buyer_types, purchase_formats, payout_models, size, signals, exclusions,
  contact_titles, contacts_per_account, playbook_id, approved_decision_id, created_at, updated_at`;

export async function saveIppDraft(tx: TenantTx, actor: Actor, input: IppInput, lineageId?: string) {
  const { rowCount } = await tx.client.query("SELECT 1 FROM abcrm.playbooks WHERE id = $1", [input.playbook_id]);
  if (!rowCount) throw new Problem("validation-failed", "Unknown playbook");
  const lineage = lineageId ?? uuidv7();
  const existing = lineageId ? await draftInLineage(tx, "ipps", lineage) : null;
  if (existing?.status === "pending_approval") throw new Problem("conflict", "The draft is awaiting approval");
  const v = [input.name, input.vertical, input.lead_types, input.buyer_types, input.purchase_formats, input.payout_models, input.size,
    input.signals, input.exclusions, input.contact_titles, input.contacts_per_account, input.playbook_id];
  if (existing) {
    const { rows: [r] } = await tx.client.query(
      `UPDATE abcrm.ipps SET name = $2, vertical = $3, lead_types = $4, buyer_types = $5, purchase_formats = $6, payout_models = $7, size = $8,
         signals = $9, exclusions = $10, contact_titles = $11, contacts_per_account = $12, playbook_id = $13 WHERE id = $1 RETURNING ${COLS}`,
      [existing.id, ...v]);
    return r;
  }
  if (lineageId) {
    const { rowCount: n } = await tx.client.query("SELECT 1 FROM abcrm.ipps WHERE lineage_id = $1 LIMIT 1", [lineageId]);
    if (!n) throw notFound("IPP");
  }
  const { rows: [r] } = await tx.client.query(
    `INSERT INTO abcrm.ipps(id, tenant_id, lineage_id, version, status, created_by, name, vertical, lead_types, buyer_types, purchase_formats,
       payout_models, size, signals, exclusions, contact_titles, contacts_per_account, playbook_id)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING ${COLS}`,
    [uuidv7(), tx.tenantId, lineage, await nextVersion(tx, "ipps", lineage), actor.type === "user" ? actor.id : null, ...v]);
  return r;
}

export async function getIpp(tx: TenantTx, id: string) {
  const { rows: [r] } = await tx.client.query(`SELECT ${COLS} FROM abcrm.ipps WHERE id = $1`, [id]);
  if (!r) throw notFound("IPP");
  return r;
}

export async function listIpps(tx: TenantTx) {
  const { rows } = await tx.client.query(`SELECT ${COLS} FROM abcrm.ipps WHERE status <> 'archived' ORDER BY created_at DESC`);
  return rows;
}

/** An IPP can only be submitted against an active playbook, so sourcing never qualifies with an unapproved one. */
export async function submitIpp(tx: TenantTx, actor: Actor, id: string) {
  const ipp = await getIpp(tx, id);
  const { rows: [p] } = await tx.client.query<{ status: string }>("SELECT status FROM abcrm.playbooks WHERE id = $1", [ipp.playbook_id]);
  if (p?.status !== "active") throw new Problem("conflict", "The IPP's playbook must be active before the IPP is submitted");
  return submitVersion(tx, actor, "ipps", id, "IPP");
}

export const activateIpp = (tx: TenantTx, actor: Actor, id: string, decisionId: string) => activateVersion(tx, actor, "ipps", id, decisionId, "IPP");
export const returnIppToDraft = (tx: TenantTx, id: string) => returnVersionToDraft(tx, "ipps", id);
