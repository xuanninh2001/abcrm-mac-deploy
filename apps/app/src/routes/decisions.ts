import { Hono } from "hono";
import { z } from "zod";
import { notFound, Problem } from "@abcrm/core";
import { approveDecision, executeApproved, rejectDecision } from "@abcrm/agents";
import type { TenantTx } from "@abcrm/db";
import type { AppEnv, Deps } from "../env.js";
import { EXECUTORS, ON_REJECT } from "../executors.js";
import { inTenant, pageLimit, requirePermission } from "./util.js";

const Approve = z.object({ content_hash: z.string().regex(/^[0-9a-f]{64}$/) });
const Reject = z.object({ reason_code: z.string().min(2).max(40), note: z.string().max(1000).optional() });

const COLS = `id, gate_id, card_id, lane, subject_type, subject_id, proposed_by, action, evidence, explanation, encode(content_hash, 'hex') AS content_hash,
  status, assignee_role, sla_due_at, decided_by, decided_at, reject_reason_code, created_at`;

/** G-Q/G-OUT belong to a card and are decided together through /cards (decision-inbox.md §2.1). */
async function cardGateGuard(tx: TenantTx, id: string) {
  const { rows: [d] } = await tx.client.query<{ gate_id: string; card_id: string | null }>("SELECT gate_id, card_id FROM abcrm.decisions WHERE id = $1", [id]);
  if (d && (d.gate_id === "G-Q" || d.gate_id === "G-OUT")) throw new Problem("conflict", `Decide this card via /v1/cards/${d.card_id}`);
}

export function decisionRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    requirePermission(c, "crm.read");
    const rows = await inTenant(deps, c, async (tx) => (await tx.client.query(
      `SELECT ${COLS} FROM abcrm.decisions WHERE status = coalesce($1, 'pending') AND ($2::text IS NULL OR lane = $2)
       ORDER BY created_at LIMIT $3`, [c.req.query("status") ?? null, c.req.query("lane") ?? null, pageLimit(c)])).rows);
    return c.json({ data: rows });
  });

  r.get("/:id", async (c) => {
    const row = await inTenant(deps, c, async (tx) => (await tx.client.query(`SELECT ${COLS} FROM abcrm.decisions WHERE id = $1`, [c.req.param("id")])).rows[0]);
    if (!row) throw notFound("Decision");
    return c.json(row);
  });

  /** Approve and execute in one transaction; the caller proves what they reviewed via content_hash. */
  r.post("/:id/approve", async (c) => {
    const { content_hash } = Approve.parse(await c.req.json());
    const id = c.req.param("id");
    const { actor } = c.get("ctx");
    const result = await inTenant(deps, c, async (tx) => {
      await cardGateGuard(tx, id);
      await approveDecision(tx, id, c.get("principal"), Buffer.from(content_hash, "hex"));
      return executeApproved(tx, id, async (action) => {
        const exec = EXECUTORS[action.tool];
        if (!exec) throw new Problem("conflict", `No executor for ${action.tool}`);
        await exec(tx, actor, action, id);
      });
    });
    return c.json({ id, status: result.executed ? "executed" : "approved" });
  });

  r.post("/:id/reject", async (c) => {
    const { reason_code, note } = Reject.parse(await c.req.json());
    const id = c.req.param("id");
    await inTenant(deps, c, async (tx) => {
      await cardGateGuard(tx, id);
      await rejectDecision(tx, id, c.get("principal"), reason_code, note);
      const { rows: [d] } = await tx.client.query<{ subject_type: string; subject_id: string }>(
        "SELECT subject_type, subject_id FROM abcrm.decisions WHERE id = $1", [id]);
      await ON_REJECT[d!.subject_type]?.(tx, d!.subject_id);
    });
    return c.json({ id, status: "rejected" });
  });

  return r;
}
