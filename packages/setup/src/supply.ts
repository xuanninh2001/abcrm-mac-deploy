import { z } from "zod";
import type { Actor, TenantTx } from "@abcrm/db";
import { appendAudit, emit, notFound, Problem, uuidv7 } from "@abcrm/core";
import { proposeDecision } from "@abcrm/agents";

const VERTICALS = ["insurance", "finance", "home_services", "education", "legal"] as const;

/** Supply Profile (ipp-playbook-format.md §1): what the agency sells. */
export const SupplyProfileInput = z.object({
  verticals: z.array(z.enum(VERTICALS)).min(1),
  lead_types: z.array(z.object({
    vertical: z.enum(VERTICALS),
    type: z.string().regex(/^[a-z0-9_]{2,40}$/),
    formats: z.array(z.enum(["data_lead", "live_transfer", "inbound_call", "appointment"])).min(1),
    delivery: z.array(z.enum(["ping_post", "direct_post", "batch"])).default([]),
    exclusivity: z.array(z.enum(["exclusive", "shared"])).default([]),
  })).min(1),
  traffic_sources: z.array(z.string().max(40)).max(20).default([]),
  daily_capacity: z.record(z.string(), z.number().int().nonnegative()).default({}),
  states: z.array(z.string().regex(/^([A-Z]{2}|ALL)$/)).default(["ALL"]),
  compliance_assets: z.object({
    trustedform: z.boolean().default(false), jornaya: z.boolean().default(false),
    consent_language_url: z.url().optional(), dnc_scrub: z.boolean().default(false),
    tcpa_seller_naming: z.enum(["per_buyer", "generic", "none"]).optional(),
  }).default({ trustedform: false, jornaya: false, dnc_scrub: false }),
  positioning: z.string().max(2000).optional(),
}).superRefine((v, ctx) => {
  for (const lt of v.lead_types) if (!v.verticals.includes(lt.vertical)) {
    ctx.addIssue({ code: "custom", message: `lead type ${lt.type} uses vertical ${lt.vertical} not in verticals` });
  }
});
export type SupplyProfileInput = z.infer<typeof SupplyProfileInput>;

const COLS = `id, version, status, verticals, lead_types, traffic_sources, daily_capacity, states, compliance_assets, positioning,
  docs, approved_decision_id, created_by, created_at, updated_at`;

export async function getSupplyProfiles(tx: TenantTx) {
  const { rows } = await tx.client.query(
    `SELECT ${COLS} FROM abcrm.supply_profiles WHERE status IN ('active', 'draft', 'pending_approval') ORDER BY version DESC`);
  return {
    active: rows.find((r) => r.status === "active") ?? null,
    draft: rows.find((r) => r.status === "draft" || r.status === "pending_approval") ?? null,
  };
}

/** Saves the working draft (one per tenant). A draft under review cannot be edited. */
export async function saveSupplyDraft(tx: TenantTx, actor: Actor, input: SupplyProfileInput) {
  const { draft } = await getSupplyProfiles(tx);
  if (draft?.status === "pending_approval") throw new Problem("conflict", "The draft is awaiting approval");
  const v = [input.verticals, JSON.stringify(input.lead_types), input.traffic_sources, input.daily_capacity, input.states, input.compliance_assets, input.positioning ?? null];
  if (draft) {
    const { rows: [r] } = await tx.client.query(
      `UPDATE abcrm.supply_profiles SET verticals = $2, lead_types = $3, traffic_sources = $4, daily_capacity = $5, states = $6,
         compliance_assets = $7, positioning = $8 WHERE id = $1 RETURNING ${COLS}`, [draft.id, ...v]);
    return r;
  }
  const { rows: [{ next }] } = await tx.client.query("SELECT coalesce(max(version), 0) + 1 AS next FROM abcrm.supply_profiles");
  const actorUser = actor.type === "user" ? actor.id : null;
  const { rows: [r] } = await tx.client.query(
    `INSERT INTO abcrm.supply_profiles(id, tenant_id, version, status, verticals, lead_types, traffic_sources, daily_capacity, states,
       compliance_assets, positioning, created_by)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLS}`,
    [uuidv7(), tx.tenantId, next, ...v, actorUser]);
  return r;
}

/** Submits the draft for G-T1 approval (setup lane). */
export async function submitSupplyDraft(tx: TenantTx, actor: Actor): Promise<{ decisionId: string }> {
  const { draft } = await getSupplyProfiles(tx);
  if (!draft || draft.status !== "draft") throw new Problem("conflict", "No draft to submit");
  await tx.client.query("UPDATE abcrm.supply_profiles SET status = 'pending_approval' WHERE id = $1", [draft.id]);
  const decisionId = await proposeDecision(tx, {
    gate: "G-T1", lane: "setup", subject: { type: "supply_profile", id: draft.id },
    action: { tool: "setup.activate", args: { kind: "supply_profile", id: draft.id, version: draft.version } },
    proposedBy: actor.type === "user" ? { type: "user", userId: actor.id } : { type: "agent", agentRunId: actor.id },
    explanation: `Activate Supply Profile v${draft.version}`,
  });
  await emit(tx, "supply.profile.submitted", { supply_profile_id: draft.id, version: draft.version });
  return { decisionId };
}

/** Executor for an approved G-T1 on a supply profile: archive the active version, activate the new one. */
export async function activateSupplyProfile(tx: TenantTx, actor: Actor, id: string, decisionId: string) {
  const { rows: [p] } = await tx.client.query("SELECT version, status FROM abcrm.supply_profiles WHERE id = $1 FOR UPDATE", [id]);
  if (!p) throw notFound("Supply profile");
  if (p.status !== "pending_approval") throw new Problem("conflict", `Supply profile is ${p.status}`);
  await tx.client.query("UPDATE abcrm.supply_profiles SET status = 'archived' WHERE status = 'active'");
  await tx.client.query("UPDATE abcrm.supply_profiles SET status = 'active', approved_decision_id = $2 WHERE id = $1", [id, decisionId]);
  await appendAudit(tx, { actor, action: "supply_profile.activated", subject: { type: "supply_profile", id } });
  await emit(tx, "supply.profile.activated", { supply_profile_id: id, version: p.version });
}

/** A rejected submission returns to draft so it can be fixed and resubmitted. */
export async function returnSupplyToDraft(tx: TenantTx, id: string) {
  await tx.client.query("UPDATE abcrm.supply_profiles SET status = 'draft' WHERE id = $1 AND status = 'pending_approval'", [id]);
}
