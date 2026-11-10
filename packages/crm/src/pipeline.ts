import type { Actor, TenantTx } from "@abcrm/db";
import { appendAudit, emit, notFound, uuidv7 } from "@abcrm/core";
import { recordChanges } from "./changes.js";
import { getAccount } from "./accounts.js";

export const OPPORTUNITY_STAGES = ["engaged", "meeting", "negotiation", "test", "won", "lost"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

const OPP_COLS = "id, account_id, stage, owner_user_id, expected_monthly_value, next_step, close_date, lost_reason, created_at, updated_at";

export async function createOpportunity(tx: TenantTx, actor: Actor, input: { accountId: string; ownerUserId?: string | null; expectedMonthlyValue?: number | null; nextStep?: string | null }) {
  await getAccount(tx, input.accountId);
  const id = uuidv7();
  const { rows: [o] } = await tx.client.query(
    `INSERT INTO abcrm.opportunities(id, tenant_id, account_id, owner_user_id, expected_monthly_value, next_step)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${OPP_COLS}`,
    [id, tx.tenantId, input.accountId, input.ownerUserId ?? null, input.expectedMonthlyValue ?? null, input.nextStep ?? null]);
  await tx.client.query("UPDATE abcrm.accounts SET status = 'opportunity' WHERE id = $1 AND status NOT IN ('partner', 'blocked')", [input.accountId]);
  await appendAudit(tx, { actor, action: "opportunity.created", subject: { type: "opportunity", id } });
  await emit(tx, "crm.opportunity.created", { opportunity_id: id, account_id: input.accountId });
  return o;
}

export async function getOpportunity(tx: TenantTx, id: string) {
  const { rows: [o] } = await tx.client.query(`SELECT ${OPP_COLS} FROM abcrm.opportunities WHERE id = $1`, [id]);
  if (!o) throw notFound("Opportunity");
  return o;
}

export async function listOpportunities(tx: TenantTx, opts: { accountId?: string; stage?: string }) {
  const { rows } = await tx.client.query(
    `SELECT ${OPP_COLS} FROM abcrm.opportunities WHERE ($1::uuid IS NULL OR account_id = $1) AND ($2::text IS NULL OR stage = $2) ORDER BY created_at DESC LIMIT 500`,
    [opts.accountId ?? null, opts.stage ?? null]);
  return rows;
}

export type OpportunityPatch = Partial<{ stage: OpportunityStage; owner_user_id: string | null; expected_monthly_value: number | null; next_step: string | null; close_date: string | null; lost_reason: string | null }>;

const OPP_PATCHABLE: ReadonlySet<string> = new Set(["stage", "owner_user_id", "expected_monthly_value", "next_step", "close_date", "lost_reason"]);

export async function updateOpportunity(tx: TenantTx, actor: Actor, id: string, patch: OpportunityPatch) {
  const before = await getOpportunity(tx, id);
  const fields = (Object.keys(patch) as (keyof OpportunityPatch)[]).filter((f) => OPP_PATCHABLE.has(f) && patch[f] !== undefined);
  if (fields.length === 0) return before;
  const { rows: [after] } = await tx.client.query(
    `UPDATE abcrm.opportunities SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING ${OPP_COLS}`,
    [id, ...fields.map((f) => patch[f])]);
  const changed = await recordChanges(tx, actor, "opportunity", id, before, after);
  if (changed.includes("stage")) {
    // Account status follows terminal stages. (Partner activation via G-B2 arrives in Phase 2.)
    if (after.stage === "lost") await tx.client.query("UPDATE abcrm.accounts SET status = 'lost' WHERE id = $1 AND status = 'opportunity'", [after.account_id]);
    await emit(tx, "crm.opportunity.stage_changed", { opportunity_id: id, from: before.stage, to: after.stage });
  }
  return after;
}

export async function addActivity(tx: TenantTx, actor: Actor, input: { accountId: string; contactId?: string | null; kind: "note" | "task" | "call" | "meeting"; body: string; dueAt?: string | null }) {
  await getAccount(tx, input.accountId);
  const id = uuidv7();
  const { rows: [a] } = await tx.client.query(
    `INSERT INTO abcrm.activities(id, tenant_id, account_id, contact_id, kind, body, due_at, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, account_id, contact_id, kind, body, due_at, done_at, actor, created_at`,
    [id, tx.tenantId, input.accountId, input.contactId ?? null, input.kind, input.body, input.dueAt ?? null, actor]);
  return a;
}

export async function listActivities(tx: TenantTx, accountId: string) {
  await getAccount(tx, accountId);
  const { rows } = await tx.client.query(
    "SELECT id, account_id, contact_id, kind, body, due_at, done_at, actor, created_at FROM abcrm.activities WHERE account_id = $1 ORDER BY created_at DESC LIMIT 200",
    [accountId]);
  return rows;
}
