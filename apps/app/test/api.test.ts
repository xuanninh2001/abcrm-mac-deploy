import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey, LocalKeyProvider } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { createApp } from "../src/app.js";
import { exitCriteriaReport, formatReport, withTenant } from "@abcrm/db";
import { notify } from "@abcrm/core";
import { ensureAgent } from "@abcrm/agents";
import { ScriptedLlm } from "@abcrm/llm";
import { proposeCard } from "@abcrm/inbox";

let t: TestDb;
let app: ReturnType<typeof createApp>;
let keyring: TenantKeyring;
const users = { a: randomUUID(), b: randomUUID(), viewerA: randomUUID(), headA: randomUUID(), adminA: randomUUID(), adminB: randomUUID(), headB: randomUUID() };
let tokenA: string, tokenB: string, tokenViewer: string, tokenHead: string, tokenAdminA: string, tokenAdminB: string, tokenHeadB: string;

beforeAll(async () => {
  t = await setupTestDb();
  keyring = new TenantKeyring(new LocalKeyProvider(generateKey()));
  app = createApp({ pool: t.app, keyring, devAuth: true });
  const ins = "INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, $3, $4, $5)";
  await t.admin.query(ins, [users.a, t.tenantA, "wa", "a@agency.vn", "sales_rep"]);
  await t.admin.query(ins, [users.b, t.tenantB, "wb", "b@agency.ph", "sales_rep"]);
  await t.admin.query(ins, [users.viewerA, t.tenantA, "wv", "v@agency.vn", "viewer"]);
  await t.admin.query(ins, [users.headA, t.tenantA, "wh", "head@agency.vn", "head_of_bd"]);
  await t.admin.query(ins, [users.adminA, t.tenantA, "waa", "admin@agency.vn", "admin"]);
  await t.admin.query(ins, [users.adminB, t.tenantB, "wab", "admin@agency.ph", "admin"]);
  await t.admin.query(ins, [users.headB, t.tenantB, "whb", "head@agency.ph", "head_of_bd"]);
  tokenA = `dev:${t.tenantA}:${users.a}`;
  tokenB = `dev:${t.tenantB}:${users.b}`;
  tokenViewer = `dev:${t.tenantA}:${users.viewerA}`;
  tokenHead = `dev:${t.tenantA}:${users.headA}`;
  tokenAdminA = `dev:${t.tenantA}:${users.adminA}`;
  tokenAdminB = `dev:${t.tenantB}:${users.adminB}`;
  tokenHeadB = `dev:${t.tenantB}:${users.headB}`;
});
afterAll(async () => { await t?.close(); });

const upload = (token: string, csv: string, purpose: string, name = "buyers.csv") => {
  const form = new FormData();
  form.set("file", new File([csv], name, { type: "text/csv" }));
  form.set("purpose", purpose);
  return app.request("/v1/imports", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
};

const call = (method: string, path: string, token?: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("auth", () => {
  it("rejects missing or forged credentials with problem+json", async () => {
    for (const token of [undefined, "garbage", `dev:${t.tenantA}:${users.b}`, `dev:${t.tenantB}:${users.a}`, "abk_unknown"]) {
      const res = await call("GET", "/v1/me", token);
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
    }
  });

  it("dev tokens are disabled when devAuth is off", async () => {
    const prod = createApp({ pool: t.app, keyring: new TenantKeyring(new LocalKeyProvider(generateKey())), devAuth: false });
    expect((await prod.request("/v1/me", { headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(401);
  });

  it("API keys resolve to their tenant; revoked keys are refused", async () => {
    const key = `abk_test_${randomUUID()}`;
    const id = randomUUID();
    await t.admin.query("INSERT INTO abcrm.api_keys(id, tenant_id, name, key_prefix, key_hash, scopes) VALUES ($1, $2, 'ci', 'abk_test', $3, '{crm.read}')",
      [id, t.tenantA, createHash("sha256").update(key).digest()]);
    const me = await (await call("GET", "/v1/me", key)).json();
    expect(me).toMatchObject({ tenant_id: t.tenantA, actor: { type: "api_key", id } });
    await t.admin.query("UPDATE abcrm.api_keys SET revoked_at = now() WHERE id = $1", [id]);
    expect((await call("GET", "/v1/me", key)).status).toBe(401);
  });
});

describe("me and users", () => {
  it("/me carries the user's profile; /users lists only the caller's tenant", async () => {
    const me = await (await call("GET", "/v1/me", tokenA)).json();
    expect(me).toMatchObject({ tenant_id: t.tenantA, role: "sales_rep", user: { id: users.a, email: "a@agency.vn", timezone: expect.any(String) } });
    const list = await (await call("GET", "/v1/users", tokenA)).json() as { data: { id: string }[] };
    const ids = list.data.map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining([users.a, users.viewerA, users.headA, users.adminA]));
    expect(ids).not.toContain(users.b);
  });
});

describe("accounts", () => {
  it("creates with normalized domain, rejects duplicates, enforces crm.write", async () => {
    const res = await call("POST", "/v1/accounts", tokenA, { name: "Acme Health Leads", domain: "https://www.AcmeHealthLeads.com/partners" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ domain: "acmehealthleads.com", status: "prospect" });
    expect((await call("POST", "/v1/accounts", tokenA, { name: "dup", domain: "acmehealthleads.com" })).status).toBe(409);
    expect((await call("POST", "/v1/accounts", tokenViewer, { name: "x", domain: "viewer.com" })).status).toBe(403);
    expect((await call("POST", "/v1/accounts", tokenA, { name: "" })).status).toBe(422);
  });

  it("the same domain can exist independently in two tenants", async () => {
    expect((await call("POST", "/v1/accounts", tokenB, { name: "Acme (B)", domain: "acmehealthleads.com" })).status).toBe(201);
  });

  it("malformed ids are 404, not 500", async () => {
    expect((await call("GET", "/v1/accounts/not-a-uuid", tokenA)).status).toBe(404);
  });
});

const supply = (positioning: string) => ({
  verticals: ["insurance"], positioning,
  lead_types: [{ vertical: "insurance", type: "aca_health", formats: ["data_lead"], delivery: ["ping_post"] }],
  compliance_assets: { trustedform: true, dnc_scrub: true },
});

/** Saves + submits a supply draft as head of BD; returns the pending G-T1 decision (reusing one already pending). */
async function submitSupplyDraft(positioning: string) {
  const pending = await (await call("GET", "/v1/decisions?lane=setup", tokenHead)).json() as { data: { id: string; content_hash: string }[] };
  if (pending.data[0]) return pending.data[0];
  expect((await call("PUT", "/v1/supply-profile/draft", tokenHead, supply(positioning))).status).toBe(200);
  const { decisionId } = await (await call("POST", "/v1/supply-profile/draft/submit", tokenHead)).json() as { decisionId: string };
  return await (await call("GET", `/v1/decisions/${decisionId}`, tokenHead)).json() as { id: string; content_hash: string };
}

describe("supply profile & G-T1 via API", () => {
  it("head of BD submits; reps cannot edit or approve; approval activates", async () => {
    expect((await call("PUT", "/v1/supply-profile/draft", tokenA, supply("rep"))).status).toBe(403);
    const d = await submitSupplyDraft("ACA data leads, TrustedForm on every lead");
    const pending = await (await call("GET", "/v1/decisions?lane=setup", tokenHead)).json() as { data: { id: string }[] };
    expect(pending.data.map((x) => x.id)).toContain(d.id);

    expect((await call("POST", `/v1/decisions/${d.id}/approve`, tokenA, { content_hash: d.content_hash })).status).toBe(403);
    expect((await call("POST", `/v1/decisions/${d.id}/approve`, tokenHead, { content_hash: "0".repeat(64) })).status).toBe(412);
    const ok = await call("POST", `/v1/decisions/${d.id}/approve`, tokenHead, { content_hash: d.content_hash });
    expect(await ok.json()).toEqual({ id: d.id, status: "executed" });
    expect((await call("POST", `/v1/decisions/${d.id}/approve`, tokenHead, { content_hash: d.content_hash })).status).toBe(409);

    const sp = await (await call("GET", "/v1/supply-profile", tokenA)).json() as { active: { positioning: string } | null; draft: unknown };
    expect(sp).toMatchObject({ active: { positioning: "ACA data leads, TrustedForm on every lead" }, draft: null });
  });

  it("rejection needs a reason and returns the profile to draft", async () => {
    const d = await submitSupplyDraft("needs work");
    expect((await call("POST", `/v1/decisions/${d.id}/reject`, tokenHead, {})).status).toBe(422);
    expect((await call("POST", `/v1/decisions/${d.id}/reject`, tokenHead, { reason_code: "incomplete" })).status).toBe(200);
    const sp = await (await call("GET", "/v1/supply-profile", tokenHead)).json() as { draft: { status: string } };
    expect(sp.draft.status).toBe("draft");
  });
});

/** A queued sourcing run on an active IPP (statuses set directly; the G-T1 path is covered elsewhere). */
async function activeIppRun() {
  const { playbook, ipp } = await cloneInsurance();
  await t.admin.query("UPDATE abcrm.playbooks SET status = 'active' WHERE id = $1", [playbook.id]);
  await t.admin.query("UPDATE abcrm.ipps SET status = 'active' WHERE id = $1", [ipp.id]);
  const res = await call("POST", "/v1/sourcing-runs", tokenA, { ipp_id: ipp.id, target_count: 50 });
  expect(res.status).toBe(201);
  return await res.json() as { id: string; status: string };
}

/** A scorecard written the way Q1 writes it (the engine itself is tested in @abcrm/qualification). */
async function seedScorecard(accountId: string, playbookId: string) {
  const candidate = randomUUID();
  const scorecard = randomUUID();
  await t.admin.query(`INSERT INTO abcrm.candidates(id, tenant_id, account_id, discovered_via, status) VALUES ($1, $2, $3, '{"kind":"manual"}', 'scored')`, [candidate, t.tenantA, accountId]);
  await t.admin.query(`INSERT INTO abcrm.scorecards(id, tenant_id, candidate_id, account_id, playbook_id, playbook_version, total_score, tier)
    VALUES ($1, $2, $3, $4, $5, 1, 80, 'A')`, [scorecard, t.tenantA, candidate, accountId, playbookId]);
  return scorecard;
}

const W1 = new ScriptedLlm({ "w1.compose": () => ({ subject: "ACA data leads", body: "Hi Ann,\n\nYou buy ACA leads.\n\nOpen to a 50-lead test this month?",
  ai_spans: [], personalization_basis: ["buys_matching_lead_types"] }) });

/** A pending card in tenant A: account + contact via the API, scorecard rows as Q1 writes them, then W1 + proposal. */
async function seedCard(domain: string) {
  const { playbook } = await cloneInsurance();
  await t.admin.query("UPDATE abcrm.playbooks SET status = 'active' WHERE id = $1", [playbook.id]);
  const account = await (await call("POST", "/v1/accounts", tokenA, { name: domain, domain })).json() as { id: string };
  const contact = await (await call("POST", `/v1/accounts/${account.id}/contacts`, tokenA, { first_name: "Ann", email: `ann@${domain}`, title: "Affiliate Manager" })).json() as { id: string };
  await t.admin.query(`UPDATE abcrm.contacts SET email_verification = '{"result":"valid"}' WHERE id = $1`, [contact.id]);
  const scorecard = await seedScorecard(account.id, playbook.id);
  const { rows: [cr] } = await t.admin.query("SELECT id FROM abcrm.criteria WHERE playbook_id = $1 AND key = 'buys_matching_lead_types'", [playbook.id]);
  await t.admin.query(`INSERT INTO abcrm.criterion_results(id, tenant_id, scorecard_id, criterion_id, result, quotes) VALUES ($1, $2, $3, $4, 'pass', '[{"text":"We buy ACA leads.","verified":true}]')`,
    [randomUUID(), t.tenantA, scorecard, cr.id]);
  const { rows: [cand] } = await t.admin.query("UPDATE abcrm.candidates SET scorecard_id = $1 WHERE id = (SELECT candidate_id FROM abcrm.scorecards WHERE id = $1) RETURNING id", [scorecard]);
  const r = await proposeCard({ pool: t.app, keyring, llm: W1 }, t.tenantA, cand.id);
  if (r.status !== "proposed") throw new Error(JSON.stringify(r));
  const card = await (await call("GET", `/v1/cards/${r.cardId}`, tokenA)).json() as { card_id: string; content_hash: string; decisions: { id: string; gate_id: string }[] };
  return { ...card, accountId: account.id, contactId: contact.id };
}

async function cloneInsurance() {
  const res = await call("POST", "/v1/vertical-packs/insurance/clone", tokenHead, { ipp_template: "ACA & FE data-lead buyers" });
  expect(res.status).toBe(201);
  return await res.json() as { playbook: { id: string; criteria: unknown[] }; ipp: { id: string } };
}

describe("playbooks, IPPs and vertical packs via API", () => {
  it("clone → submit playbook → approve → submit IPP → approve", async () => {
    expect((await (await call("GET", "/v1/vertical-packs", tokenA)).json())).toEqual({ data: ["finance", "home_services", "insurance"] });
    expect((await call("POST", "/v1/vertical-packs/insurance/clone", tokenA, { ipp_template: "ACA & FE data-lead buyers" })).status).toBe(403);
    const { playbook, ipp } = await cloneInsurance();
    expect(playbook.criteria).toHaveLength(11);
    expect((await call("POST", `/v1/ipps/${ipp.id}/submit`, tokenHead, {})).status).toBe(409);   // playbook not active yet

    const approveSubmitted = async (decisionId: string) => {
      const d = await (await call("GET", `/v1/decisions/${decisionId}`, tokenHead)).json() as { content_hash: string };
      return (await call("POST", `/v1/decisions/${decisionId}/approve`, tokenHead, { content_hash: d.content_hash })).json();
    };
    const pb = await (await call("POST", `/v1/playbooks/${playbook.id}/submit`, tokenHead, {})).json() as { decisionId: string };
    expect(await approveSubmitted(pb.decisionId)).toMatchObject({ status: "executed" });
    expect((await call("PUT", `/v1/playbooks/${playbook.id}`, tokenHead, { name: "x", criteria: playbook.criteria })).status).toBe(409);
    const is = await (await call("POST", `/v1/ipps/${ipp.id}/submit`, tokenHead, {})).json() as { decisionId: string };
    expect(await approveSubmitted(is.decisionId)).toMatchObject({ status: "executed" });
    expect(await (await call("GET", `/v1/ipps/${ipp.id}`, tokenA)).json()).toMatchObject({ status: "active" });
  });
});

describe("cross-tenant fuzz (test-plan §2.3)", () => {
  it("every GET /:id route returns 404 for another tenant's resource", async () => {
    const account = await (await call("POST", "/v1/accounts", tokenA, { name: "Secret Buyer", domain: "secretbuyer.com" })).json() as { id: string };
    const contact = await (await call("POST", `/v1/accounts/${account.id}/contacts`, tokenA, { email: "ceo@secretbuyer.com" })).json() as { id: string };
    const opp = await (await call("POST", "/v1/opportunities", tokenA, { account_id: account.id })).json() as { id: string };
    const decision = await submitSupplyDraft("fuzz");
    const job = await (await upload(tokenAdminA, "Domain\nfuzz.com\n", "accounts")).json() as { jobId: string };
    const cloned = await cloneInsurance();
    const run = await activeIppRun();
    const preview = await (await call("POST", `/v1/playbooks/${cloned.playbook.id}/preview`, tokenHead, {})).json() as { id: string };
    const lookup = await (await call("POST", `/v1/accounts/${account.id}/contacts/find`, tokenA, { titles: ["Affiliate Manager"], limit: 1 })).json() as { id: string };
    const scorecard = await seedScorecard(account.id, cloned.playbook.id);
    const card = await seedCard("fuzzcard.com");
    const agent = await withTenant(t.app, t.tenantA, { type: "system", id: "test" }, (tx) => ensureAgent(tx, "Q1"));
    const idFor: Record<string, string> = { accounts: account.id, contacts: contact.id, opportunities: opp.id, decisions: decision.id, imports: job.jobId,
      playbooks: cloned.playbook.id, ipps: cloned.ipp.id, "sourcing-runs": run.id, "playbook-previews": preview.id, "contact-lookups": lookup.id, scorecards: scorecard,
      cards: card.card_id, agents: agent.definitionId };
    const owner = (res: string) => (res === "imports" ? tokenAdminA : tokenA);
    const other = (res: string) => (res === "imports" ? tokenAdminB : tokenB);

    const idRoutes = app.routes.filter((r) => r.method === "GET" && r.path.includes(":id"));
    expect(idRoutes.length).toBeGreaterThanOrEqual(5);
    for (const r of idRoutes) {
      const resource = r.path.split("/")[2]!;
      const id = idFor[resource];
      expect(id, `no fixture for ${r.path}`).toBeDefined();
      const path = r.path.replace(":id", id!);
      expect((await call("GET", path, owner(resource))).status, `owner ${path}`).toBe(200);
      expect((await call("GET", path, other(resource))).status, `cross-tenant ${path}`).toBe(404);
    }
  });

  it("every PATCH/POST/DELETE /:id route returns 404 for another tenant's resource", async () => {
    const account = await (await call("POST", "/v1/accounts", tokenA, { name: "Write Target", domain: "writetarget.com" })).json() as { id: string };
    const contact = await (await call("POST", `/v1/accounts/${account.id}/contacts`, tokenA, { email: "x@writetarget.com" })).json() as { id: string };
    const opp = await (await call("POST", "/v1/opportunities", tokenA, { account_id: account.id })).json() as { id: string };
    const decision = await submitSupplyDraft("fuzz-write");
    const job = await (await upload(tokenAdminA, "Domain\nfuzzwrite.com\n", "accounts")).json() as { jobId: string };
    const cloned = await cloneInsurance();
    const pbInput = await (await call("GET", `/v1/playbooks/${cloned.playbook.id}`, tokenHead)).json() as { name: string; criteria: unknown[] };
    const ippBody = { name: "x", vertical: "insurance", lead_types: ["aca_health"], buyer_types: ["aggregator"], contact_titles: ["Affiliate Manager"], playbook_id: cloned.playbook.id };
    const run = await activeIppRun();
    const card = await seedCard("fuzzwritecard.com");
    const agent = await withTenant(t.app, t.tenantA, { type: "system", id: "test" }, (tx) => ensureAgent(tx, "W1"));
    const note = await withTenant(t.app, t.tenantA, { type: "system", id: "test" }, (tx) => notify(tx, { userId: users.a, kind: "x", title: "t", body: "b" }));
    const idFor: Record<string, string> = { accounts: account.id, contacts: contact.id, opportunities: opp.id, decisions: decision.id, imports: job.jobId,
      playbooks: cloned.playbook.id, ipps: cloned.ipp.id, "sourcing-runs": run.id, cards: card.card_id, agents: agent.definitionId, notifications: note, users: users.viewerA };
    const bodies: Record<string, unknown> = {
      "PATCH /v1/accounts/:id": { name: "pwned" }, "POST /v1/accounts/:id/flags": { add: ["competitor"] },
      "POST /v1/accounts/:id/contacts": { email: "evil@writetarget.com" }, "POST /v1/accounts/:id/activities": { kind: "note", body: "x" },
      "PATCH /v1/contacts/:id": { title: "pwned" }, "PATCH /v1/opportunities/:id": { stage: "won" },
      "POST /v1/decisions/:id/approve": { content_hash: decision.content_hash }, "POST /v1/decisions/:id/reject": { reason_code: "other" },
      "PUT /v1/imports/:id/mapping": { field_map: [{ source: "Domain", target: "company_domain" }] },
      "POST /v1/imports/:id/dry-run": {}, "POST /v1/imports/:id/commit": {}, "POST /v1/imports/:id/rollback": {},
      "PUT /v1/playbooks/:id": { name: pbInput.name, criteria: pbInput.criteria }, "POST /v1/playbooks/:id/versions": { name: pbInput.name, criteria: pbInput.criteria },
      "POST /v1/playbooks/:id/submit": {}, "PUT /v1/ipps/:id": ippBody, "POST /v1/ipps/:id/versions": ippBody, "POST /v1/ipps/:id/submit": {},
      "POST /v1/sourcing-runs/:id/pause": {}, "POST /v1/sourcing-runs/:id/resume": {}, "POST /v1/sourcing-runs/:id/cancel": {},
      "POST /v1/playbooks/:id/preview": {}, "POST /v1/accounts/:id/contacts/find": { titles: ["Affiliate Manager"], limit: 1 },
      "POST /v1/cards/:id/approve": { content_hash: card.content_hash }, "POST /v1/cards/:id/reject": { reason_code: "too_small" },
      "POST /v1/cards/:id/snooze": { until: new Date(Date.now() + 86_400_000).toISOString() },
      "PATCH /v1/agents/:id": { credit_budget_daily: 1 }, "POST /v1/agents/:id/pause": {}, "POST /v1/agents/:id/resume": {},
      "POST /v1/cards/:id/reassign": { user_id: users.b }, "POST /v1/cards/:id/criteria/:key/verify": { note: "x" }, "POST /v1/notifications/:id/read": {},
      "PATCH /v1/users/:id": { role: "admin" }, "DELETE /v1/users/:id": {}, "POST /v1/users/:id/resend-invite": {},
    };
    const writeRoutes = app.routes.filter((r) => ["PATCH", "POST", "PUT", "DELETE"].includes(r.method) && r.path.includes(":id") && !r.path.startsWith("/v1/suppression"));
    for (const r of writeRoutes) {
      const key = `${r.method} ${r.path}`;
      expect(bodies[key], `no body fixture for ${key}`).toBeDefined();
      const resource = r.path.split("/")[2]!;
      const token = resource === "imports" || resource === "users" ? tokenAdminB : ["playbooks", "ipps", "agents"].includes(resource) || key.endsWith("/reassign") ? tokenHeadB : tokenB;
      const res = await call(r.method, r.path.replace(":id", idFor[resource]!).replace(":key", "buys_matching_lead_types"), token, bodies[key]);
      expect(res.status, `cross-tenant ${key}`).toBe(404);
    }
    const after = await (await call("GET", `/v1/accounts/${account.id}`, tokenA)).json() as { name: string; flags: string[] };
    expect(after).toMatchObject({ name: "Write Target", flags: [] });
    expect(await (await call("GET", `/v1/cards/${card.card_id}`, tokenA)).json()).toMatchObject({ status: "pending" });
    expect(await (await call("GET", `/v1/agents/${agent.definitionId}`, tokenA)).json()).toMatchObject({ status: "active", credit_budget_daily: null });
    expect((await t.admin.query("SELECT role, status FROM abcrm.users WHERE id = $1", [users.viewerA])).rows[0]).toEqual({ role: "viewer", status: "active" });
  });

  it("list endpoints never include another tenant's rows", async () => {
    const list = await (await call("GET", "/v1/accounts?limit=200", tokenB)).json() as { data: { name: string }[] };
    expect(list.data.map((a) => a.name)).not.toContain("Secret Buyer");
  });
});

describe("crm endpoints", () => {
  it("patches accounts with validation and flags them", async () => {
    const a = await (await call("POST", "/v1/accounts", tokenA, { name: "Patch Me", domain: "patchme.com" })).json() as { id: string };
    expect((await call("PATCH", `/v1/accounts/${a.id}`, tokenA, { hq_state: "tx", buyer_type: "aggregator" })).status).toBe(200);
    expect((await call("PATCH", `/v1/accounts/${a.id}`, tokenA, { domain: "other.com" })).status).toBe(422);   // domain is immutable
    expect((await call("PATCH", `/v1/accounts/${a.id}`, tokenViewer, { name: "x" })).status).toBe(403);
    const flagged = await (await call("POST", `/v1/accounts/${a.id}/flags`, tokenA, { add: ["existing_buyer"] })).json();
    expect(flagged).toMatchObject({ hq_state: "TX", buyer_type: "aggregator", flags: ["existing_buyer"] });
  });

  it("suppression: reps add, viewers cannot read, only admins remove", async () => {
    const created = await call("POST", "/v1/suppression", tokenA, { kind: "email", value: "stop@buyer.com", reason: "manual" });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect((await call("GET", "/v1/suppression", tokenViewer)).status).toBe(403);
    expect((await call("DELETE", `/v1/suppression/${id}`, tokenA)).status).toBe(403);   // sales_rep lacks compliance.manage
    const list = await (await call("GET", "/v1/suppression", tokenA)).json() as { data: { value: string }[] };
    expect(list.data.map((e) => e.value)).toContain("stop@buyer.com");
  });
});

describe("imports via API", () => {
  const csv = "First Name,Last Name,Title,Company,Email,Website\nJane,Doe,Affiliate Manager,Gamma Leads,jane@gammaleads.com,gammaleads.com\nBob,X,y,Personal,bob@gmail.com,\n";

  it("upload → mapping → dry-run → commit → rollback; admin-only", async () => {
    expect((await upload(tokenA, csv, "contacts")).status).toBe(403);
    const staged = await (await upload(tokenAdminA, csv, "contacts")).json() as { jobId: string; fieldMap: unknown[]; rows: number };
    expect(staged.rows).toBe(2);
    expect((await call("POST", `/v1/imports/${staged.jobId}/dry-run`, tokenAdminA, {})).status).toBe(409);   // mapping not approved yet
    expect((await call("PUT", `/v1/imports/${staged.jobId}/mapping`, tokenAdminA, { field_map: staged.fieldMap })).status).toBe(200);
    const stats = await (await call("POST", `/v1/imports/${staged.jobId}/dry-run`, tokenAdminA, {})).json();
    expect(stats).toMatchObject({ rows: 2, valid: 1, error: 1 });
    const errors = await (await call("GET", `/v1/imports/${staged.jobId}/rows?status=error`, tokenAdminA)).json() as { data: { row_no: number }[] };
    expect(errors.data.map((r) => r.row_no)).toEqual([3]);
    expect(await (await call("POST", `/v1/imports/${staged.jobId}/commit`, tokenAdminA, {})).json()).toEqual({ created: 1, matched: 0, suppressed: 0 });
    const accounts = await (await call("GET", "/v1/accounts?q=gammaleads", tokenA)).json() as { data: { id: string; source: { kind: string } }[] };
    expect(accounts.data[0]!.source.kind).toBe("import");
    const rb = await (await call("POST", `/v1/imports/${staged.jobId}/rollback`, tokenAdminA, {})).json();
    expect(rb).toMatchObject({ deleted: 2 });   // the contact and the account it created

    // The import screen: history and the purpose's fields with required alternatives.
    const history = await (await call("GET", "/v1/imports", tokenAdminA)).json() as { data: { id: string; status: string; created_by_email: string }[] };
    expect(history.data.find((j) => j.id === staged.jobId)).toMatchObject({ status: "rolled_back", created_by_email: "admin@agency.vn" });
    expect((await call("GET", "/v1/imports", tokenA)).status).toBe(403);
    await expect((await call("GET", "/v1/imports", tokenAdminB)).json()).resolves.toMatchObject({ data: expect.not.arrayContaining([expect.objectContaining({ id: staged.jobId })]) });
    const job = await (await call("GET", `/v1/imports/${staged.jobId}`, tokenAdminA)).json() as { targets: { required: string[][] }; headers: string[] };
    expect(job.targets.required).toContainEqual(["email"]);
    expect(job.headers).toContain("Website");
  });

  it("rejects bad files", async () => {
    expect((await upload(tokenAdminA, "%PDF-1.4", "contacts", "x.pdf")).status).toBe(422);
    expect((await upload(tokenAdminA, "Email\n", "contacts")).status).toBe(422);
    expect((await upload(tokenAdminA, csv, "everything")).status).toBe(422);
  });
});

describe("sourcing runs via API", () => {
  it("small runs queue immediately; large runs wait for G-T1 and start on approval; reps can pause/cancel", async () => {
    const small = await activeIppRun();
    expect(small.status).toBe("queued");
    expect(await (await call("POST", `/v1/sourcing-runs/${small.id}/pause`, tokenA, {})).json()).toMatchObject({ status: "paused" });
    expect((await call("POST", `/v1/sourcing-runs/${small.id}/pause`, tokenA, {})).status).toBe(409);
    expect(await (await call("POST", `/v1/sourcing-runs/${small.id}/cancel`, tokenA, {})).json()).toMatchObject({ status: "cancelled" });

    const { ipp } = await cloneInsurance();
    expect((await call("POST", "/v1/sourcing-runs", tokenA, { ipp_id: ipp.id, target_count: 10 })).status).toBe(409);   // IPP not active
    await t.admin.query("UPDATE abcrm.ipps SET status = 'active' WHERE id = $1", [ipp.id]);
    const big = await (await call("POST", "/v1/sourcing-runs", tokenA, { ipp_id: ipp.id, target_count: 800 })).json() as { id: string; status: string; decision_id: string };
    expect(big.status).toBe("pending_approval");
    const d = await (await call("GET", `/v1/decisions/${big.decision_id}`, tokenHead)).json() as { content_hash: string };
    expect((await call("POST", `/v1/decisions/${big.decision_id}/approve`, tokenA, { content_hash: d.content_hash })).status).toBe(403);
    expect(await (await call("POST", `/v1/decisions/${big.decision_id}/approve`, tokenHead, { content_hash: d.content_hash })).json()).toMatchObject({ status: "executed" });
    expect(await (await call("GET", `/v1/sourcing-runs/${big.id}`, tokenA)).json()).toMatchObject({ status: "queued" });
    expect(await (await call("POST", "/v1/sourcing-runs/estimate", tokenA, { target_count: 200 })).json()).toMatchObject({ agent_credits: 400 });
  });
});

describe("qualification and contact lookups via API", () => {
  it("manual candidates, previews, scorecards and lookups are queued for the worker with the right permissions", async () => {
    const res = await call("POST", "/v1/candidates/manual", tokenA, { domain: "https://www.ManualBuyer.com/about", note: "met at LeadsCon" });
    expect(res.status).toBe(201);
    const { candidate_id, account_id } = await res.json() as { candidate_id: string; account_id: string };
    const ev = await t.admin.query("SELECT topic FROM abcrm.outbox WHERE payload->>'candidate_id' = $1", [candidate_id]);
    expect(ev.rows.map((r) => r.topic)).toEqual(["sourcing.candidate.ready"]);
    expect(await (await call("GET", `/v1/accounts/${account_id}`, tokenA)).json()).toMatchObject({ domain: "manualbuyer.com" });
    expect((await call("POST", "/v1/candidates/manual", tokenViewer, { domain: "x.com" })).status).toBe(403);

    const { playbook } = await cloneInsurance();
    expect((await call("POST", `/v1/playbooks/${playbook.id}/preview`, tokenA, {})).status).toBe(403);
    const pv = await call("POST", `/v1/playbooks/${playbook.id}/preview`, tokenHead, { size: 50 });
    expect(pv.status).toBe(422);
    const ok = await (await call("POST", `/v1/playbooks/${playbook.id}/preview`, tokenHead, { size: 5 })).json() as { id: string; status: string };
    expect(ok.status).toBe("running");
    expect(await (await call("GET", `/v1/playbooks/${playbook.id}/previews`, tokenHead)).json()).toMatchObject({ data: [{ id: ok.id }] });

    const sc = await seedScorecard(account_id, playbook.id);
    expect(await (await call("GET", `/v1/accounts/${account_id}/scorecards`, tokenViewer)).json()).toMatchObject({ data: [{ id: sc, tier: "A" }] });
    expect(await (await call("GET", `/v1/scorecards/${sc}`, tokenViewer)).json()).toMatchObject({ id: sc, criteria: [] });

    expect((await call("POST", `/v1/accounts/${account_id}/contacts/find`, tokenViewer, { limit: 1 })).status).toBe(403);
    expect((await call("POST", `/v1/accounts/${account_id}/contacts/find`, tokenA, { limit: 9 })).status).toBe(422);
    const lk = await (await call("POST", `/v1/accounts/${account_id}/contacts/find`, tokenA, { titles: ["Affiliate Manager"], limit: 2 })).json() as { id: string; status: string };
    expect(lk).toMatchObject({ status: "reserved", titles: ["Affiliate Manager"], limit: 2 });
    expect(await (await call("GET", `/v1/contact-lookups/${lk.id}`, tokenA)).json()).toMatchObject({ id: lk.id, status: "reserved" });
  });
});

describe("decision inbox via API", () => {
  it("approve-to-contact card: list, detail, approve with the email; G-Q cannot be decided via /decisions", async () => {
    const card = await seedCard("inboxbuyer.com");
    const list = await (await call("GET", "/v1/cards", tokenViewer)).json() as { data: { card_id: string; content_hash: string; has_draft: boolean }[] };
    expect(list.data.find((x) => x.card_id === card.card_id)).toMatchObject({ content_hash: card.content_hash, has_draft: true });
    const gq = card.decisions.find((d) => d.gate_id === "G-Q")!;
    expect((await call("POST", `/v1/decisions/${gq.id}/approve`, tokenHead, { content_hash: "0".repeat(64) })).status).toBe(409);
    expect((await call("POST", `/v1/cards/${card.card_id}/approve`, tokenViewer, { content_hash: card.content_hash })).status).toBe(403);
    expect((await call("POST", `/v1/cards/${card.card_id}/approve`, tokenA, { content_hash: "a".repeat(64) })).status).toBe(412);
    const res = await call("POST", `/v1/cards/${card.card_id}/approve`, tokenA, { content_hash: card.content_hash, send_first_email: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: { status: "approved" }, email_draft: { status: "approved" } });
    expect(await (await call("GET", `/v1/accounts/${card.accountId}`, tokenA)).json()).toMatchObject({ status: "approved" });
  });

  it("reject needs a known reason; bulk approve skips changed cards; snooze validates the time", async () => {
    const a = await seedCard("rejectme.com");
    expect((await call("POST", `/v1/cards/${a.card_id}/reject`, tokenA, { reason_code: "meh" })).status).toBe(422);
    expect((await call("POST", `/v1/cards/${a.card_id}/reject`, tokenA, { reason_code: "other" })).status).toBe(422);
    expect(await (await call("POST", `/v1/cards/${a.card_id}/reject`, tokenA, { reason_code: "competitor" })).json()).toMatchObject({ status: "rejected" });

    const b = await seedCard("bulkapi1.com");
    const c = await seedCard("bulkapi2.com");
    const bulk = await (await call("POST", "/v1/cards/bulk-approve", tokenA, { card_ids: [b.card_id, c.card_id], content_hashes: { [b.card_id]: b.content_hash, [c.card_id]: "b".repeat(64) } })).json();
    expect(bulk).toEqual({ approved: [b.card_id], skipped: [{ card_id: c.card_id, reason: "updated_review_again" }] });
    expect((await call("POST", `/v1/cards/${c.card_id}/snooze`, tokenA, { until: "yesterday" })).status).toBe(422);
    expect((await call("POST", `/v1/cards/${c.card_id}/snooze`, tokenA, { until: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(200);
  });

  it("usage, spend caps, agent budgets and the kill switch need the right roles", async () => {
    const usage = await (await call("GET", "/v1/usage", tokenA)).json() as { balances: { meter: string; included: number; used: number }[]; by_action: { action_type: string }[] };
    expect(usage.balances.map((b) => b.meter)).toEqual(["agent", "contact"]);
    expect(usage.by_action.map((r) => r.action_type)).toContain("card");
    expect((await call("PATCH", "/v1/usage/settings", tokenHead, { meter: "agent", overage_enabled: true })).status).toBe(403);
    const set = await (await call("PATCH", "/v1/usage/settings", tokenAdminA, { meter: "agent", overage_enabled: true, spend_cap_usd: 25 })).json() as { data: { meter: string; overage_enabled: boolean; spend_cap_usd: number }[] };
    expect(set.data.find((b) => b.meter === "agent")).toMatchObject({ overage_enabled: true, spend_cap_usd: 25 });

    const agents = await (await call("GET", "/v1/agents", tokenA)).json() as { data: { id: string; template_key: string }[] };
    const w1 = agents.data.find((a) => a.template_key === "W1")!;
    expect((await call("PATCH", `/v1/agents/${w1.id}`, tokenA, { credit_budget_daily: 100 })).status).toBe(403);
    expect(await (await call("PATCH", `/v1/agents/${w1.id}`, tokenHead, { credit_budget_daily: 100 })).json()).toMatchObject({ credit_budget_daily: 100 });
    expect(await (await call("POST", `/v1/agents/${w1.id}/pause`, tokenHead, {})).json()).toMatchObject({ status: "paused", paused_reason: "manual" });
    expect(await (await call("POST", `/v1/agents/${w1.id}/resume`, tokenHead, {})).json()).toMatchObject({ status: "active", paused_reason: null });

    expect((await call("POST", "/v1/tenant/kill-switch", tokenHead, { enabled: true })).status).toBe(403);
    expect(await (await call("POST", "/v1/tenant/kill-switch", tokenAdminA, { enabled: true })).json()).toEqual({ kill_switch: true });
    await call("POST", "/v1/tenant/kill-switch", tokenAdminA, { enabled: false });
  });
});

describe("routing and notifications via API", () => {
  it("reps see their own and unassigned cards; heads reassign; reps verify unknown criteria; notifications list and read", async () => {
    const card = await seedCard("routeapi.com");
    const detail = await (await call("GET", `/v1/cards/${card.card_id}`, tokenHead)).json() as { assignee_user_id: string };
    expect(detail.assignee_user_id).toBe(users.a);   // the tenant's only sales rep
    expect((await call("POST", `/v1/cards/${card.card_id}/reassign`, tokenA, { user_id: users.headA })).status).toBe(403);
    expect(await (await call("POST", `/v1/cards/${card.card_id}/reassign`, tokenHead, { user_id: users.headA })).json()).toMatchObject({ assignee_user_id: users.headA });
    const repList = await (await call("GET", "/v1/cards", tokenA)).json() as { data: { card_id: string }[] };
    expect(repList.data.map((x) => x.card_id)).not.toContain(card.card_id);   // now assigned to the head of BD
    const headMine = await (await call("GET", "/v1/cards?mine=true", tokenHead)).json() as { data: { card_id: string }[] };
    expect(headMine.data.map((x) => x.card_id)).toEqual([card.card_id]);

    await t.admin.query("UPDATE abcrm.criterion_results SET result = 'unknown' WHERE scorecard_id = (SELECT (action->'args'->>'scorecardId')::uuid FROM abcrm.decisions WHERE card_id = $1 AND gate_id = 'G-Q')", [card.card_id]);
    expect((await call("POST", `/v1/cards/${card.card_id}/criteria/buys_matching_lead_types/verify`, tokenViewer, { note: "x" })).status).toBe(403);
    expect(await (await call("POST", `/v1/cards/${card.card_id}/criteria/buys_matching_lead_types/verify`, tokenHead, { note: "Confirmed on a call" })).json())
      .toMatchObject({ criterion_key: "buys_matching_lead_types" });

    const inbox = await (await call("GET", "/v1/notifications", tokenHead)).json() as { unread: number; data: { id: string; kind: string }[] };
    const assigned = inbox.data.find((n) => n.kind === "card_assigned")!;
    expect(inbox.unread).toBeGreaterThan(0);
    expect((await call("POST", `/v1/notifications/${assigned.id}/read`, tokenA, {})).status).toBe(404);   // someone else's
    expect(await (await call("POST", `/v1/notifications/${assigned.id}/read`, tokenHead, {})).json()).toEqual({ id: assigned.id, read: true });
  });
});

describe("team management via API", () => {
  it("admins invite; a first dev sign-in activates; guards keep owners and the caller safe", async () => {
    const owner = randomUUID();
    await t.admin.query("INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, 'wo', 'owner@agency.vn', 'owner')", [owner, t.tenantA]);
    const tokenOwner = `dev:${t.tenantA}:${owner}`;

    expect((await call("POST", "/v1/users", tokenHead, { email: "x@agency.vn", role: "sales_rep" })).status).toBe(403);
    expect((await call("POST", "/v1/users", tokenAdminA, { email: "boss@agency.vn", role: "owner" })).status).toBe(403);
    expect((await call("POST", "/v1/users", tokenAdminA, { email: "not-an-email", role: "sales_rep" })).status).toBe(422);
    const res = await call("POST", "/v1/users", tokenAdminA, { email: "New.Rep@Agency.vn", name: "New Rep", role: "sales_rep" });
    expect(res.status).toBe(201);
    const invited = await res.json() as { user: { id: string; email: string; status: string }; invitation: { sent: boolean; reason: string } };
    expect(invited).toMatchObject({ user: { email: "new.rep@agency.vn", status: "invited" }, invitation: { sent: false, reason: "workos_not_configured" } });
    expect((await call("POST", "/v1/users", tokenAdminA, { email: "new.rep@agency.vn", role: "viewer" })).status).toBe(409);
    const active = await (await call("GET", "/v1/users", tokenA)).json() as { data: { id: string }[] };
    expect(active.data.map((u) => u.id)).not.toContain(invited.user.id);
    const all = await (await call("GET", "/v1/users?all=true", tokenAdminA)).json() as { data: { id: string; status: string }[] };
    expect(all.data.find((u) => u.id === invited.user.id)).toMatchObject({ status: "invited" });

    // First sign-in activates the invite and tells the inviter.
    const tokenNew = `dev:${t.tenantA}:${invited.user.id}`;
    expect(await (await call("GET", "/v1/me", tokenNew)).json()).toMatchObject({ role: "sales_rep", user: { id: invited.user.id } });
    expect((await call("POST", `/v1/users/${invited.user.id}/resend-invite`, tokenAdminA, {})).status).toBe(409);
    const adminInbox = await (await call("GET", "/v1/notifications", tokenAdminA)).json() as { data: { kind: string }[] };
    expect(adminInbox.data.map((n) => n.kind)).toContain("user_activated");

    // Role changes: admins cannot touch owners, nobody changes their own role, the last owner stays.
    expect(await (await call("PATCH", `/v1/users/${invited.user.id}`, tokenAdminA, { role: "head_of_bd" })).json()).toMatchObject({ user: { role: "head_of_bd" } });
    expect((await call("PATCH", `/v1/users/${owner}`, tokenAdminA, { role: "admin" })).status).toBe(403);
    expect((await call("PATCH", `/v1/users/${invited.user.id}`, tokenAdminA, { role: "owner" })).status).toBe(403);
    expect((await call("PATCH", `/v1/users/${users.adminA}`, tokenAdminA, { status: "disabled" })).status).toBe(409);
    expect((await call("PATCH", `/v1/users/${owner}`, tokenOwner, { role: "admin" })).status).toBe(409);
    expect((await call("PATCH", `/v1/users/${users.adminA}`, tokenOwner, { role: "owner" })).status).toBe(200);
    expect((await call("PATCH", `/v1/users/${owner}`, tokenAdminA, { status: "disabled" })).status).toBe(200);   // adminA is an owner now
    expect((await call("PATCH", `/v1/users/${users.adminA}`, tokenAdminA, { role: "admin" })).status).toBe(409);  // own role
    await t.admin.query("UPDATE abcrm.users SET role = 'admin' WHERE id = $1", [users.adminA]);
    await t.admin.query("UPDATE abcrm.users SET status = 'active' WHERE id = $1", [owner]);

    // Disabling hands pending cards to the next reviewer and locks the user out at once.
    const card = await seedCard("handoff.com");
    await call("POST", `/v1/cards/${card.card_id}/reassign`, tokenHead, { user_id: invited.user.id });
    const off = await (await call("DELETE", `/v1/users/${invited.user.id}`, tokenAdminA)).json() as { user: { status: string }; cards_reassigned: number };
    expect(off).toMatchObject({ user: { status: "disabled" }, cards_reassigned: 1 });
    const after = await (await call("GET", `/v1/cards/${card.card_id}`, tokenHead)).json() as { assignee_user_id: string };
    expect(after.assignee_user_id).not.toBe(invited.user.id);
    expect((await call("GET", "/v1/me", tokenNew)).status).toBe(401);
    expect(await (await call("PATCH", `/v1/users/${invited.user.id}`, tokenAdminA, { status: "active" })).json()).toMatchObject({ user: { status: "active" } });

    // A never-activated invite that is revoked and restored goes back to 'invited'.
    const pending = await (await call("POST", "/v1/users", tokenAdminA, { email: "later@agency.vn", role: "viewer" })).json() as { user: { id: string } };
    await call("DELETE", `/v1/users/${pending.user.id}`, tokenAdminA);
    expect(await (await call("PATCH", `/v1/users/${pending.user.id}`, tokenAdminA, { status: "active" })).json()).toMatchObject({ user: { status: "invited" } });
  });

  it("everyone edits their own profile; timezone and working hours are validated", async () => {
    expect((await call("PATCH", "/v1/users/me", tokenViewer, { timezone: "Mars/Olympus" })).status).toBe(422);
    expect((await call("PATCH", "/v1/users/me", tokenViewer, { working_hours: { "mon-fri": ["18:00", "09:00"] } })).status).toBe(422);
    expect((await call("PATCH", "/v1/users/me", tokenViewer, { working_hours: { weekdays: ["09:00", "17:00"] } })).status).toBe(422);
    const r = await (await call("PATCH", "/v1/users/me", tokenViewer, { name: "Vi Ewer", timezone: "Asia/Manila", working_hours: { "mon-fri": ["09:00", "18:00"], sat: ["09:00", "12:00"] } })).json();
    expect(r).toMatchObject({ id: users.viewerA, name: "Vi Ewer", timezone: "Asia/Manila", working_hours: { sat: ["09:00", "12:00"] } });
  });
});

describe("hardening", () => {
  it("limits requests per caller and failed sign-ins per address; Retry-After is set", async () => {
    const limited = createApp({ pool: t.app, keyring, devAuth: true, limits: { perActorPerMin: 3, authFailuresPerIpPerMin: 2 } });
    const get = (token: string, ip = "203.0.113.7") => limited.request("/v1/me", { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": `${ip}, 10.0.0.1` } });
    for (let i = 0; i < 3; i++) expect((await get(tokenA)).status).toBe(200);
    const over = await get(tokenA);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get(tokenViewer)).status).toBe(200);              // another caller has its own budget

    expect((await get("garbage", "198.51.100.9")).status).toBe(401);
    expect((await get("garbage", "198.51.100.9")).status).toBe(401);
    expect((await get(tokenHead, "198.51.100.9")).status).toBe(429);   // even a valid token, from that address, for a while
    expect((await get(tokenHead, "198.51.100.10")).status).toBe(200);
  });

  it("rejects oversized bodies and sends security headers", async () => {
    const big = JSON.stringify({ name: "x".repeat(1024 * 1024 + 10), domain: "big.com" });
    const res = await app.request("/v1/accounts", { method: "POST", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" }, body: big });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ title: "Request body too large" });
    const ok = await call("GET", "/v1/me", tokenA);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("stores the review time and reports Phase 1 exit criteria per tenant", async () => {
    const card = await seedCard("reviewtime.com");
    expect((await call("POST", `/v1/cards/${card.card_id}/approve`, tokenA, { content_hash: card.content_hash, review_ms: 12_500 })).status).toBe(200);
    expect((await t.admin.query("SELECT review_ms FROM abcrm.decisions WHERE card_id = $1 AND gate_id = 'G-Q'", [card.card_id])).rows[0].review_ms).toBe(12_500);
    expect((await call("POST", `/v1/cards/${card.card_id}/approve`, tokenA, { content_hash: card.content_hash, review_ms: -1 })).status).toBe(422);

    const [report] = await exitCriteriaReport(t.admin, { tenantId: t.tenantA });
    const c = Object.fromEntries(report!.checks.map((x) => [x.key, x]));
    expect(c.gq_cards!.value).toBeGreaterThan(0);
    expect(c.gq_cards!.ok).toBe(false);                                 // far below 300 in tests
    expect(c.unverified_quotes_on_cards).toMatchObject({ value: 0, ok: true });
    expect(c.inv1_violations).toMatchObject({ value: 0, ok: true });
    expect(c.median_review_seconds!.value).toBe(12.5);
    expect(c.metering_mismatches).toMatchObject({ value: 0, ok: true });
    expect(formatReport([report!])).toContain("Median review time per card");
  });
});
