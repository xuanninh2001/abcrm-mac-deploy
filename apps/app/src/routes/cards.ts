import { Hono } from "hono";
import { z } from "zod";
import { approveCard, bulkApprove, getCard, listCards, reassignCard, rejectCard, REJECT_REASONS, snoozeCard, verifyCriterion } from "@abcrm/inbox";
import type { TenantTx } from "@abcrm/db";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, pageLimit, requirePermission } from "./util.js";

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Approve = z.object({
  content_hash: Hash,
  contact_ids: z.array(z.uuid()).min(1).max(5).optional(),
  send_first_email: z.boolean().default(true),
  draft: z.object({ subject: z.string().min(1).max(120), body: z.string().min(1).max(2500) }).optional(),
  review_ms: z.number().int().min(0).max(3_600_000).optional(),
});
const ReviewMs = z.number().int().min(0).max(3_600_000).optional();

/** Time the reviewer spent on the card, measured by the web app (exit criterion: median < 30 s). */
const recordReview = (tx: TenantTx, cardId: string, ms: number | undefined) => (ms === undefined ? Promise.resolve() :
  tx.client.query("UPDATE abcrm.decisions SET review_ms = $2 WHERE card_id = $1 AND gate_id = 'G-Q'", [cardId, ms]).then(() => undefined));

/** Decision Inbox: approve-to-contact cards (decision-inbox.md, api.md §2.5). */
export function cardRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    requirePermission(c, "crm.read");
    const p = c.get("principal");
    const viewer = p.type === "user" ? { id: p.id, role: p.role } : undefined;
    return c.json({ data: await inTenant(deps, c, (tx) => listCards(tx, {
      status: c.req.query("status"), groupKey: c.req.query("group_key"), includeSnoozed: c.req.query("include_snoozed") === "true", limit: pageLimit(c),
      viewer, mine: c.req.query("mine") === "true",
    })) });
  });
  r.get("/:id", async (c) => {
    requirePermission(c, "crm.read");
    return c.json(await inTenant(deps, c, (tx) => getCard(tx, deps.keyring, c.req.param("id"))));
  });
  r.post("/bulk-approve", async (c) => {
    requirePermission(c, "decisions.approve.G-Q");
    const body = z.object({ card_ids: z.array(z.uuid()).min(1).max(100), content_hashes: z.record(z.string(), Hash) }).parse(await c.req.json());
    const { tenantId, actor } = c.get("ctx");
    const cards = body.card_ids.map((id) => ({ cardId: id, contentHash: body.content_hashes[id] ?? "" }));
    return c.json(await bulkApprove(deps.pool, tenantId, actor, c.get("principal"), cards));
  });
  r.post("/:id/approve", async (c) => {
    requirePermission(c, "decisions.approve.G-Q");
    const b = Approve.parse(await c.req.json());
    return c.json(await inTenant(deps, c, async (tx) => {
      const res = await approveCard(tx, c.get("ctx").actor, c.get("principal"), c.req.param("id"), {
        contentHash: b.content_hash, contactIds: b.contact_ids, sendFirstEmail: b.send_first_email, draft: b.draft });
      await recordReview(tx, c.req.param("id"), b.review_ms);
      return res;
    }));
  });
  r.post("/:id/reject", async (c) => {
    requirePermission(c, "decisions.approve.G-Q");
    const b = z.object({ reason_code: z.enum(REJECT_REASONS), note: z.string().max(1000).optional(), review_ms: ReviewMs }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, async (tx) => {
      const res = await rejectCard(tx, c.get("principal"), c.req.param("id"), b.reason_code, b.note);
      await recordReview(tx, c.req.param("id"), b.review_ms);
      return res;
    }));
  });
  r.post("/:id/snooze", async (c) => {
    requirePermission(c, "decisions.approve.G-Q");
    const { until } = z.object({ until: z.iso.datetime({ offset: true }) }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => snoozeCard(tx, c.req.param("id"), new Date(until))));
  });
  r.post("/:id/reassign", async (c) => {
    const { user_id } = z.object({ user_id: z.uuid() }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => reassignCard(tx, c.get("principal"), c.req.param("id"), user_id)));
  });
  r.post("/:id/criteria/:key/verify", async (c) => {
    const { note } = z.object({ note: z.string().min(1).max(1000) }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => verifyCriterion(tx, c.get("principal"), c.req.param("id"), c.req.param("key"), note)));
  });
  return r;
}
