// Drizzle table definitions for tables used by application code so far.
// The SQL migrations are the source of truth; keep these in sync (checked by test/schema-sync.test.ts).
import { bigint, boolean, customType, date, integer, jsonb, numeric, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const abcrm = pgSchema("abcrm");
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const tenants = abcrm.table("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  region: text("region").notNull(),
  plan: text("plan").notNull(),
  status: text("status").notNull(),
  killSwitch: boolean("kill_switch").notNull(),
  settings: jsonb("settings").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const users = abcrm.table("users", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  workosUserId: text("workos_user_id").notNull(),
  email: text("email").notNull(),
  name: text("name"),
  role: text("role").notNull(),
  timezone: text("timezone").notNull(),
  workingHours: jsonb("working_hours").notNull(),
  locale: text("locale").notNull(),
  status: text("status").notNull(),
});

export const tenantKeys = abcrm.table("tenant_keys", {
  tenantId: uuid("tenant_id").notNull(),
  keyVersion: integer("key_version").notNull(),
  purpose: text("purpose").notNull(),
  wrappedKey: bytea("wrapped_key").notNull(),
  kmsKeyRef: text("kms_key_ref").notNull(),
  status: text("status").notNull(),
});

export const accounts = abcrm.table("accounts", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  domainBidx: bytea("domain_bidx").notNull(),
  buyerType: text("buyer_type"),
  verticals: text("verticals").array().notNull(),
  leadTypes: text("lead_types").array().notNull(),
  hqState: text("hq_state"),
  hqCountry: text("hq_country"),
  employeeRange: text("employee_range"),
  status: text("status").notNull(),
  flags: text("flags").array().notNull(),
  ownerUserId: uuid("owner_user_id"),
  source: jsonb("source").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const outbox = abcrm.table("outbox", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  topic: text("topic").notNull(),
  payload: jsonb("payload").notNull(),
  causationId: uuid("causation_id"),
  correlationId: uuid("correlation_id"),
  createdAt: ts("created_at").notNull(),
  dispatchedAt: ts("dispatched_at"),
});

export const auditLog = abcrm.table("audit_log", {
  id: uuid("id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  at: ts("at").notNull(),
  actor: jsonb("actor").notNull(),
  action: text("action").notNull(),
  subject: jsonb("subject").notNull(),
  prevHash: bytea("prev_hash"),
  hash: bytea("hash").notNull(),
});

export const decisions = abcrm.table("decisions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  gateId: text("gate_id").notNull(),
  cardId: uuid("card_id"),
  lane: text("lane").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  proposedBy: jsonb("proposed_by").notNull(),
  action: jsonb("action").notNull(),
  contentHash: bytea("content_hash").notNull(),
  status: text("status").notNull(),
  decidedBy: uuid("decided_by"),
  decidedAt: ts("decided_at"),
  finalAction: jsonb("final_action"),
  finalContentHash: bytea("final_content_hash"),
  rejectReasonCode: text("reject_reason_code"),
  executedAt: ts("executed_at"),
});

export const usageBalances = abcrm.table("usage_balances", {
  tenantId: uuid("tenant_id").notNull(),
  period: date("period").notNull(),
  meter: text("meter").notNull(),
  included: numeric("included").notNull(),
  used: numeric("used").notNull(),
  overageEnabled: boolean("overage_enabled").notNull(),
  spendCapUsd: numeric("spend_cap_usd"),
  overageUnitPriceUsd: numeric("overage_unit_price_usd").notNull(),
  hardStop: boolean("hard_stop").notNull(),
});

export const usageEvents = abcrm.table("usage_events", {
  id: uuid("id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  occurredAt: ts("occurred_at").notNull(),
  meter: text("meter").notNull(),
  actionType: text("action_type").notNull(),
  credits: numeric("credits").notNull(),
  agentRunId: uuid("agent_run_id"),
  billable: boolean("billable").notNull(),
});

export const costLedger = abcrm.table("cost_ledger", {
  id: uuid("id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  occurredAt: ts("occurred_at").notNull(),
  kind: text("kind").notNull(),
  vendor: text("vendor").notNull(),
  costUsdMicros: bigint("cost_usd_micros", { mode: "number" }).notNull(),
});
