import { DBOS } from "@dbos-inc/dbos-sdk";
import { withTenant, type Actor, type TenantTx } from "@abcrm/db";
import { uuidFromName } from "@abcrm/core";
import { findContacts, type ContactDataDeps } from "@abcrm/contactdata";
import { qualifyCandidate, runPreview, type PageSource } from "@abcrm/qualification";
import { proposeCard, type Messaging } from "@abcrm/inbox";
import { loadPack } from "@abcrm/setup";
import type { LlmGateway } from "@abcrm/llm";
import { onEvent } from "../dispatcher.js";
import { agentQueue } from "../queues.js";

export type QualificationWorkerDeps = {
  pool: ContactDataDeps["pool"];
  llm: LlmGateway | null;
  pages?: PageSource;
  contacts: ContactDataDeps;
};

const messagingFor = async (vertical: string) => ((await loadPack(vertical).catch(() => null))?.messaging as Messaging | undefined) ?? null;

const s2: Actor = { type: "system", id: "contact-finder" };
const step = <T>(name: string, fn: () => Promise<T>) => DBOS.runStep(fn, { name });

/**
 * Q1 on `sourcing.candidate.ready`, S2 on card-eligible `qualification.scorecard.created`,
 * manual contact lookups and playbook previews. Workflow ids are derived from the subject, so a
 * candidate is qualified once and a scorecard triggers one lookup however often events are redelivered.
 */
export function registerQualification(deps: QualificationWorkerDeps) {
  async function qualify(tenantId: string, candidateId: string, eventId: string) {
    return qualifyCandidate({ pool: deps.pool, llm: deps.llm, pages: deps.pages, step }, tenantId, candidateId, { eventId });
  }
  const qualifyWf = DBOS.registerWorkflow(qualify, { name: "qualifyCandidate" });

  async function findForScorecard(tenantId: string, scorecardId: string, candidateId: string, accountId: string) {
    const plan = await step("s2:plan", () => withTenant(deps.pool, tenantId, s2, (tx) => planLookup(tx, candidateId, accountId)));
    if (!plan) return { status: "skipped" };
    if (plan.lookup) {
      const pack = await loadPack(plan.vertical).catch(() => null);
      const result = await step("s2:find", () => findContacts(deps.contacts, tenantId, s2, {
        lookupId: uuidFromName(`s2:${tenantId}:${scorecardId}`), accountId, candidateId, titles: plan.titles, synonyms: pack?.contact_titles.synonyms,
        limit: plan.limit, creditBudget: plan.budget, sourcingRunId: plan.runId,
      }));
      if (plan.runId && result.contactCredits > 0) {
        await step("s2:stats", () => withTenant(deps.pool, tenantId, s2, (tx) => tx.client.query(
          `UPDATE abcrm.sourcing_runs SET stats = stats || jsonb_build_object('contact_credits_used', coalesce((stats->>'contact_credits_used')::numeric, 0) + $2)
           WHERE id = $1`, [plan.runId, result.contactCredits])));
      }
    }
    // Q1 step 5: with ≥ 1 contact, W1 writes the first email and the card goes to the inbox.
    return proposeCard({ pool: deps.pool, keyring: deps.contacts.keyring, llm: deps.llm, messagingFor, step }, tenantId, candidateId);
  }
  const contactsWf = DBOS.registerWorkflow(findForScorecard, { name: "findContactsForScorecard" });

  async function manualLookup(tenantId: string, lookupId: string, accountId: string, titles: string[], limit: number) {
    return step("lookup", () => findContacts(deps.contacts, tenantId, s2, { lookupId, accountId, titles, limit }));
  }
  const manualWf = DBOS.registerWorkflow(manualLookup, { name: "manualContactLookup" });

  async function preview(tenantId: string, previewId: string) {
    await runPreview({ pool: deps.pool, llm: deps.llm, step }, tenantId, previewId);
  }
  const previewWf = DBOS.registerWorkflow(preview, { name: "playbookPreview" });

  onEvent("sourcing.candidate.ready", async (e) => {
    const candidateId = String(e.payload.candidate_id);
    await DBOS.startWorkflow(qualifyWf, { workflowID: `q1:${candidateId}`, ...(await agentQueue(deps.pool, e.tenant_id)) })(e.tenant_id, candidateId, e.id);
  });
  onEvent("qualification.scorecard.created", async (e) => {
    if (!e.payload.card_eligible) return;
    const scorecardId = String(e.payload.scorecard_id);
    await DBOS.startWorkflow(contactsWf, { workflowID: `s2:${scorecardId}`, ...(await agentQueue(deps.pool, e.tenant_id)) })(e.tenant_id, scorecardId, String(e.payload.candidate_id), String(e.payload.account_id));
  });
  onEvent("contactdata.lookup.requested", async (e) => {
    const p = e.payload as { contact_lookup_id: string; account_id: string; titles: string[]; limit: number };
    await DBOS.startWorkflow(manualWf, { workflowID: `lookup:${p.contact_lookup_id}`, ...(await agentQueue(deps.pool, e.tenant_id)) })(e.tenant_id, p.contact_lookup_id, p.account_id, p.titles, p.limit);
  });
  onEvent("playbook.preview.requested", async (e) => {
    const previewId = String(e.payload.preview_id);
    await DBOS.startWorkflow(previewWf, { workflowID: `preview:${previewId}`, ...(await agentQueue(deps.pool, e.tenant_id)) })(e.tenant_id, previewId);
  });
  return { qualifyWf, contactsWf, manualWf, previewWf };
}

/** S2 trigger rule: look up only when the account lacks enough valid contacts; titles and limits come from the run's IPP. */
async function planLookup(tx: TenantTx, candidateId: string, accountId: string) {
  const { rows: [c] } = await tx.client.query<{ sourcing_run_id: string | null }>("SELECT sourcing_run_id FROM abcrm.candidates WHERE id = $1", [candidateId]);
  if (!c) return null;
  const { rows: [ipp] } = c.sourcing_run_id
    ? await tx.client.query<{ vertical: string; contact_titles: string[]; contacts_per_account: number; contact_credit_budget: number; used: string | null }>(
      `SELECT i.vertical, i.contact_titles, i.contacts_per_account, r.contact_credit_budget, r.stats->>'contact_credits_used' AS used
       FROM abcrm.sourcing_runs r JOIN abcrm.ipps i ON i.id = r.ipp_id WHERE r.id = $1`, [c.sourcing_run_id])
    : await tx.client.query<{ vertical: string; contact_titles: string[]; contacts_per_account: number; contact_credit_budget: number; used: string | null }>(
      `SELECT vertical, contact_titles, contacts_per_account, NULL::int AS contact_credit_budget, NULL AS used FROM abcrm.ipps
       WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`);
  if (!ipp) return null;
  const { rows: [v] } = await tx.client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM abcrm.contacts WHERE account_id = $1 AND status = 'active' AND email_verification->>'result' = 'valid'", [accountId]);
  const budget = ipp.contact_credit_budget === null ? undefined : Math.max(0, ipp.contact_credit_budget - Number(ipp.used ?? 0));
  const lookup = v!.n < ipp.contacts_per_account && budget !== 0;
  return { lookup, vertical: ipp.vertical, titles: ipp.contact_titles, limit: Math.max(1, ipp.contacts_per_account - v!.n), budget, runId: c.sourcing_run_id };
}
