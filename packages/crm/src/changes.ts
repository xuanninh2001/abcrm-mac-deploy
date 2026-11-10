import type { Actor, TenantTx } from "@abcrm/db";
import { uuidv7 } from "@abcrm/core";

const METADATA = new Set(["id", "created_at", "updated_at"]);

/** Writes one record_changes row per changed field (field history, Undo, "who changed this"). */
export async function recordChanges(
  tx: TenantTx, actor: Actor, recordType: string, recordId: string,
  before: Record<string, unknown>, after: Record<string, unknown>,
): Promise<string[]> {
  const changed = Object.keys(after)
    .filter((k) => !METADATA.has(k))
    .filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
  for (const field of changed) {
    await tx.client.query(
      `INSERT INTO abcrm.record_changes(id, tenant_id, record_type, record_id, field, old_value, new_value, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uuidv7(), tx.tenantId, recordType, recordId, field, JSON.stringify(before[field] ?? null), JSON.stringify(after[field] ?? null),
        actor.type === "api_key" ? "integration" : actor.type, actor.id]);
  }
  return changed;
}
