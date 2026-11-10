import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notify, notifyRoles, uuidv7 } from "@abcrm/core";
import { withTenant, type TenantTx } from "@abcrm/db";
import { setupTestDb, type TestDb } from "@abcrm/db/testing";
import { deliverNotification, DisabledMailer, listNotifications, markRead, PostmarkMailer, sendDigest } from "../src/index.js";

let t: TestDb;
const rep = randomUUID(), owner = randomUUID(), repB = randomUUID();
const sys = { type: "system", id: "test" } as const;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantA, sys, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(t.app, t.tenantB, sys, fn);

beforeAll(async () => {
  t = await setupTestDb();
  const ins = "INSERT INTO abcrm.users(id, tenant_id, workos_user_id, email, role) VALUES ($1, $2, $3, $4, $5)";
  await t.admin.query(ins, [rep, t.tenantA, "r", "rep@a.vn", "sales_rep"]);
  await t.admin.query(ins, [owner, t.tenantA, "o", "owner@a.vn", "owner"]);
  await t.admin.query(ins, [repB, t.tenantB, "rb", "rep@b.ph", "sales_rep"]);
});
afterAll(async () => { await t?.close(); });

describe("notifications", () => {
  it("in-app list, unread count, mark read; isolated per tenant and user", async () => {
    const id = await inA((tx) => notify(tx, { userId: rep, kind: "card_assigned", title: "A card", body: "Open it", payload: { card_id: "x" } }));
    expect(await inA((tx) => notifyRoles(tx, ["owner", "admin"], { kind: "billing_threshold", title: "80% used", body: "b" }))).toBe(1);
    const mine = await inA((tx) => listNotifications(tx, rep, { limit: 10 }));
    expect(mine).toMatchObject({ unread: 1, data: [{ id, kind: "card_assigned" }] });
    await expect(inA((tx) => markRead(tx, owner, id))).rejects.toMatchObject({ status: 404 });
    await expect(inB((tx) => markRead(tx, rep, id))).rejects.toMatchObject({ status: 404 });
    await inA((tx) => markRead(tx, rep, id));
    expect((await inA((tx) => listNotifications(tx, rep, { limit: 10, unreadOnly: true }))).unread).toBe(0);
    const ev = await t.admin.query("SELECT count(*)::int AS n FROM abcrm.outbox WHERE topic = 'notifications.notification.created'");
    expect(ev.rows[0].n).toBe(2);
  });

  it("email delivery: disabled adapter skips, Postmark sends, errors are recorded", async () => {
    const mk = () => inA((tx) => notify(tx, { userId: rep, kind: "card_overdue", title: "Overdue", body: "b" }));
    const off = new DisabledMailer();
    expect(await deliverNotification(t.app, off, t.tenantA, await mk())).toBe("skipped");
    expect(off.sent[0]).toMatchObject({ to: "rep@a.vn", subject: "[ABCRM] Overdue" });

    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new PostmarkMailer("tok", "noreply@abcrm.app", (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ MessageID: "m1" }), { status: 200 });
    }) as typeof fetch);
    const id2 = await mk();
    expect(await deliverNotification(t.app, ok, t.tenantA, id2)).toBe("sent");
    expect(await deliverNotification(t.app, ok, t.tenantA, id2)).toBe("sent");   // already delivered → not resent
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init.headers).get("x-postmark-server-token")).toBe("tok");
    const bad = new PostmarkMailer("tok", "x@y", (async () => new Response("nope", { status: 422 })) as typeof fetch);
    expect(await deliverNotification(t.app, bad, t.tenantA, await mk())).toBe("failed");
  });

  it("digest counts the cards a user can act on, once per local day", async () => {
    await inA(async (tx) => {
      const pb = uuidv7(), acc = uuidv7(), cand = uuidv7(), sc = uuidv7();
      await tx.client.query("INSERT INTO abcrm.playbooks(id, tenant_id, lineage_id, name, version, status, definition_hash) VALUES ($1, $2, $1, 'P', 1, 'active', 'h')", [pb, tx.tenantId]);
      await tx.client.query("INSERT INTO abcrm.accounts(id, tenant_id, name, domain, domain_bidx) VALUES ($1, $2, 'A', 'a.com', $3)", [acc, tx.tenantId, Buffer.from(randomUUID())]);
      await tx.client.query(`INSERT INTO abcrm.candidates(id, tenant_id, account_id, discovered_via, status) VALUES ($1, $2, $3, '{}', 'carded')`, [cand, tx.tenantId, acc]);
      await tx.client.query(`INSERT INTO abcrm.scorecards(id, tenant_id, candidate_id, account_id, playbook_id, playbook_version, total_score, tier) VALUES ($1, $2, $3, $4, $5, 1, 90, 'A')`,
        [sc, tx.tenantId, cand, acc, pb]);
      await tx.client.query(`INSERT INTO abcrm.decisions(id, tenant_id, gate_id, card_id, lane, subject_type, subject_id, proposed_by, action, content_hash, assignee_user_id, sla_due_at)
        VALUES ($1, $2, 'G-Q', $3, 'contact', 'account', $4, '{}', $5, '\\x00', $6, now() - interval '1 hour')`, [uuidv7(), tx.tenantId, uuidv7(), acc, { tool: "account.approve_contact", args: { scorecardId: sc } }, rep]);
    });
    expect(await inA((tx) => sendDigest(tx, rep, "2026-10-26"))).toBe(true);
    expect(await inA((tx) => sendDigest(tx, rep, "2026-10-26"))).toBe(false);
    const n = (await inA((tx) => listNotifications(tx, rep, { limit: 20 }))).data.find((x: { kind: string }) => x.kind === "digest");
    expect(n).toMatchObject({ title: "1 cards ready, 1 Tier A", payload: { total: 1, tier_a: 1, overdue: 1 } });
    expect(await inB((tx) => sendDigest(tx, repB, "2026-10-26"))).toBe(false);   // nothing to do in tenant B
  });
});
