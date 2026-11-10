// E2E backend: a throwaway database seeded with one rep and three cards, served by the real API with dev tokens.
// Writes the ids the spec needs to e2e/.state.json, then serves until killed.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring, uuidv7 } from "@abcrm/core";
import { withTenant } from "@abcrm/db";
import { setupTestDb } from "@abcrm/db/testing";
import { createAccount, createContact } from "@abcrm/crm";
import { ScriptedLlm } from "@abcrm/llm";
import { proposeCard } from "@abcrm/inbox";
import { createApp } from "@abcrm/app/src/app.ts";

const port = Number(process.env.E2E_API_PORT ?? 3100);
const t = await setupTestDb();
const keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));
const rep = randomUUID();
const actor = { type: "user", id: rep } as const;
await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, name, role) VALUES ($1, $2, 'e2e', 'rep@agency.vn', 'Rep One', 'sales_rep')", [rep, t.tenantA]);
const admin = randomUUID();
await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, name, role) VALUES ($1, $2, 'e2e-admin', 'admin@agency.vn', 'Ad Min', 'admin')", [admin, t.tenantA]);
const playbookId = uuidv7();
const criterionId = uuidv7();
await t.admin.query("INSERT INTO abcrm.playbooks(id, tenant_id, lineage_id, name, version, status, definition_hash) VALUES ($1, $2, $1, 'PB', 1, 'draft', 'h')", [playbookId, t.tenantA]);
await t.admin.query(`INSERT INTO abcrm.criteria(id, tenant_id, playbook_id, key, name, description, kind, evaluation, order_no)
  VALUES ($1, $2, $3, 'buys_leads', 'Buys leads', 'd', 'must_have', 'ai_judged', 0)`, [criterionId, t.tenantA, playbookId]);
await t.admin.query("UPDATE abcrm.playbooks SET status = 'active' WHERE id = $1", [playbookId]);

const W1 = { subject: "ACA data leads with TrustedForm", body: "Hi Ann,\n\nYou buy ACA leads from publishers. We supply ACA data leads with TrustedForm.\n\nOpen to a 50-lead test this month?\n\n{{sender_name}}",
  ai_spans: [{ start: 9, end: 45 }], personalization_basis: ["buys_leads"] };
const deps = { pool: t.app, keyring, llm: new ScriptedLlm({ "w1.compose": () => W1 }),
  messagingFor: async () => ({ angles: ["TrustedForm"], avoid: ["guaranteed"], cta_options: ["Open to a 50-lead test this month?"] }) };

/** The shape Q1 + S2 leave behind: a tier-A scorecard with a quoted criterion and one valid contact. */
async function card(domain: string) {
  const candidateId = await withTenant(t.app, t.tenantA, actor, async (tx) => {
    const { account } = await createAccount(tx, keyring, actor, { name: domain, domain });
    const { contact } = await createContact(tx, keyring, actor, account.id, { firstName: "Ann", title: "Affiliate Manager", email: `ann@${domain}`, source: { kind: "provider" } });
    await tx.client.query(`UPDATE abcrm.contacts SET email_verification = '{"result":"valid"}' WHERE id = $1`, [contact.id]);
    const candidate = uuidv7();
    const scorecard = uuidv7();
    await tx.client.query(`INSERT INTO abcrm.candidates(id, tenant_id, account_id, discovered_via, status) VALUES ($1, $2, $3, '{"kind":"manual"}', 'scored')`, [candidate, tx.tenantId, account.id]);
    await tx.client.query(`INSERT INTO abcrm.scorecards(id, tenant_id, candidate_id, account_id, playbook_id, playbook_version, total_score, tier, summary)
      VALUES ($1, $2, $3, $4, $5, 1, 90, 'A', '- Buys ACA leads from publishers')`, [scorecard, tx.tenantId, candidate, account.id, playbookId]);
    await tx.client.query("UPDATE abcrm.candidates SET scorecard_id = $2 WHERE id = $1", [candidate, scorecard]);
    const ev = uuidv7();
    await tx.client.query(`INSERT INTO abcrm.evidence(id, tenant_id, account_id, kind, url, retrieved_at, snippet, content_hash)
      VALUES ($1, $2, $3, 'web_page', $4, now(), 'We buy ACA leads from publishers.', $5)`, [ev, tx.tenantId, account.id, `https://${domain}/partners`, Buffer.from(randomUUID())]);
    await tx.client.query("INSERT INTO abcrm.criterion_results(id, tenant_id, scorecard_id, criterion_id, result, quotes) VALUES ($1, $2, $3, $4, 'pass', $5)",
      [uuidv7(), tx.tenantId, scorecard, criterionId, JSON.stringify([{ evidence_id: ev, text: "We buy ACA leads from publishers.", verified: true }])]);
    await tx.client.query(`INSERT INTO abcrm.contact_lookups(id, tenant_id, account_id, candidate_id, titles, limit_n, status, results) VALUES ($1, $2, $3, $4, '{x}', 1, 'completed', $5)`,
      [uuidv7(), tx.tenantId, account.id, candidate, JSON.stringify([{ contactId: contact.id, preselected: true }])]);
    return candidate;
  });
  const r = await proposeCard(deps, t.tenantA, candidateId);
  if (r.status !== "proposed") throw new Error(`seed failed: ${JSON.stringify(r)}`);
  return r.cardId;
}

const cards = [await card("alpha-leads.com"), await card("bravo-leads.com"), await card("charlie-leads.com")];
await writeFile(fileURLToPath(new URL("./.state.json", import.meta.url)), JSON.stringify({ tenantId: t.tenantA, userId: rep, adminId: admin, cards }));

const server = serve({ fetch: createApp({ pool: t.app, keyring, devAuth: true }).fetch, port }, () => console.log(`e2e api on :${port}`));
const stop = async () => { server.close(); await t.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
