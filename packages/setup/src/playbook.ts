import { createHash } from "node:crypto";
import { z } from "zod";
import type { Actor, TenantTx } from "@abcrm/db";
import { canonicalJson, notFound, Problem, uuidv7 } from "@abcrm/core";
import { validateRule } from "@abcrm/qualification";
import { activateVersion, draftInLineage, nextVersion, returnVersionToDraft, submitVersion } from "./versioned.js";

const HINTS = ["home", "about", "partners", "publishers", "careers", "compliance", "pricing", "blog"] as const;

/** ipp-playbook-format.md §4. */
export const CriterionInput = z.object({
  key: z.string().regex(/^[a-z0-9_]{3,48}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  kind: z.enum(["knockout", "must_have", "scored"]),
  evaluation: z.enum(["rule", "ai_judged"]),
  rule: z.unknown().optional().transform((v) => v ?? undefined),   // DB returns null for ai_judged criteria
  weight: z.number().int().min(0).max(100).default(0),
  evidence_required: z.boolean().default(true),
  unknown_policy: z.enum(["neutral", "penalize", "block"]).default("neutral"),
  unknown_penalty: z.number().int().min(0).max(50).default(0),
  hints: z.array(z.enum(HINTS)).default([]),
}).superRefine((c, ctx) => {
  if ((c.evaluation === "rule") !== (c.rule !== undefined)) ctx.addIssue({ code: "custom", message: `${c.key}: rule is required exactly when evaluation is "rule"` });
  if (c.kind === "scored" && c.weight === 0) ctx.addIssue({ code: "custom", message: `${c.key}: scored criteria need a weight` });
  if (c.kind !== "scored" && c.weight !== 0) ctx.addIssue({ code: "custom", message: `${c.key}: only scored criteria have a weight` });
  if (c.rule !== undefined) for (const e of validateRule(c.rule)) ctx.addIssue({ code: "custom", message: `${c.key}: ${e}` });
});

export type CriterionInput = z.infer<typeof CriterionInput>;

export const PlaybookInput = z.object({
  name: z.string().min(1).max(120),
  vertical_pack: z.string().max(40).optional(),
  tier_thresholds: z.object({ A: z.number().int(), B: z.number().int(), C: z.number().int() }).default({ A: 75, B: 55, C: 35 }),
  card_min_tier: z.enum(["A", "B", "C"]).default("B"),
  criteria: z.array(CriterionInput).min(1).max(40),
}).superRefine((p, ctx) => {
  const { A, B, C } = p.tier_thresholds;
  if (!(100 >= A && A > B && B > C && C >= 0)) ctx.addIssue({ code: "custom", message: "tier thresholds must satisfy 100 ≥ A > B > C ≥ 0" });
  if (new Set(p.criteria.map((c) => c.key)).size !== p.criteria.length) ctx.addIssue({ code: "custom", message: "criterion keys must be unique" });
  if (!p.criteria.some((c) => c.kind !== "knockout")) ctx.addIssue({ code: "custom", message: "at least one must_have or scored criterion is required" });
});
export type PlaybookInput = z.infer<typeof PlaybookInput>;

const definitionHash = (p: PlaybookInput) =>
  createHash("sha256").update(canonicalJson({ t: p.tier_thresholds, m: p.card_min_tier, c: p.criteria })).digest("hex");

/** Saves the lineage's working draft (new lineage when lineageId is omitted). Returns the playbook with criteria. */
export async function savePlaybookDraft(tx: TenantTx, actor: Actor, input: PlaybookInput, lineageId?: string) {
  const lineage = lineageId ?? uuidv7();
  const existing = lineageId ? await draftInLineage(tx, "playbooks", lineage) : null;
  if (existing?.status === "pending_approval") throw new Problem("conflict", "The draft is awaiting approval");
  let id: string;
  if (existing) {
    id = existing.id;
    await tx.client.query("DELETE FROM abcrm.criteria WHERE playbook_id = $1", [id]);
    await tx.client.query(
      "UPDATE abcrm.playbooks SET name = $2, vertical_pack = $3, tier_thresholds = $4, card_min_tier = $5, definition_hash = $6 WHERE id = $1",
      [id, input.name, input.vertical_pack ?? null, input.tier_thresholds, input.card_min_tier, definitionHash(input)]);
  } else {
    if (lineageId) {
      const { rowCount } = await tx.client.query("SELECT 1 FROM abcrm.playbooks WHERE lineage_id = $1 LIMIT 1", [lineageId]);
      if (!rowCount) throw notFound("Playbook");
    }
    id = uuidv7();
    await tx.client.query(
      `INSERT INTO abcrm.playbooks(id, tenant_id, lineage_id, name, version, status, vertical_pack, tier_thresholds, card_min_tier, definition_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10)`,
      [id, tx.tenantId, lineage, input.name, await nextVersion(tx, "playbooks", lineage), input.vertical_pack ?? null, input.tier_thresholds,
        input.card_min_tier, definitionHash(input), actor.type === "user" ? actor.id : null]);
  }
  for (const [i, c] of input.criteria.entries()) {
    await tx.client.query(
      `INSERT INTO abcrm.criteria(id, tenant_id, playbook_id, key, name, description, kind, evaluation, rule, weight, evidence_required,
         unknown_policy, unknown_penalty, hints, order_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [uuidv7(), tx.tenantId, id, c.key, c.name, c.description, c.kind, c.evaluation, c.rule === undefined ? null : JSON.stringify(c.rule),
        c.weight, c.evidence_required, c.unknown_policy, c.unknown_penalty, c.hints, i + 1]);
  }
  return getPlaybook(tx, id);
}

export async function getPlaybook(tx: TenantTx, id: string) {
  const { rows: [p] } = await tx.client.query(
    `SELECT id, lineage_id, name, version, status, vertical_pack, tier_thresholds, card_min_tier, definition_hash, approved_decision_id, created_at, updated_at
     FROM abcrm.playbooks WHERE id = $1`, [id]);
  if (!p) throw notFound("Playbook");
  const { rows: criteria } = await tx.client.query(
    `SELECT key, name, description, kind, evaluation, rule, weight, evidence_required, unknown_policy, unknown_penalty, hints, order_no
     FROM abcrm.criteria WHERE playbook_id = $1 ORDER BY order_no`, [id]);
  return { ...p, criteria };
}

/** One row per lineage: its active version and any open draft. */
export async function listPlaybooks(tx: TenantTx) {
  const { rows } = await tx.client.query(
    `SELECT lineage_id,
            max(name) FILTER (WHERE status = 'active') AS active_name,
            max(id::text) FILTER (WHERE status = 'active') AS active_id,
            max(version) FILTER (WHERE status = 'active') AS active_version,
            max(id::text) FILTER (WHERE status IN ('draft', 'pending_approval')) AS draft_id,
            max(status) FILTER (WHERE status IN ('draft', 'pending_approval')) AS draft_status,
            max(name) AS name
     FROM abcrm.playbooks GROUP BY lineage_id ORDER BY max(created_at) DESC`);
  return rows;
}

/** Submits for G-T1 with the latest completed preview of this exact criteria set attached for the approver (§3.2). */
export async function submitPlaybook(tx: TenantTx, actor: Actor, id: string) {
  const { rows: [pv] } = await tx.client.query(
    `SELECT pv.id, pv.sample_size, pv.tier_distribution, pv.finished_at FROM abcrm.playbook_previews pv JOIN abcrm.playbooks p ON p.id = pv.playbook_id
     WHERE pv.playbook_id = $1 AND pv.status = 'completed' AND pv.definition_hash = p.definition_hash ORDER BY pv.created_at DESC LIMIT 1`, [id]);
  return submitVersion(tx, actor, "playbooks", id, "Playbook", pv ? { preview: pv } : { preview: null });
}
export const activatePlaybook = (tx: TenantTx, actor: Actor, id: string, decisionId: string) => activateVersion(tx, actor, "playbooks", id, decisionId, "Playbook");
export const returnPlaybookToDraft = (tx: TenantTx, id: string) => returnVersionToDraft(tx, "playbooks", id);
