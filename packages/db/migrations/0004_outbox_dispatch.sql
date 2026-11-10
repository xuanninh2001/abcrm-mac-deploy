-- Migration 0004: cross-tenant outbox dispatch for the worker.
-- The outbox is RLS-scoped per tenant; the dispatcher needs every tenant's pending events. These two
-- SECURITY DEFINER functions are the only cross-tenant path and expose IDs-only payloads (events.md §1).
SET search_path = abcrm, public;

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
DROP INDEX IF EXISTS outbox_pending;
CREATE INDEX outbox_pending ON outbox (created_at) WHERE dispatched_at IS NULL;

-- Lease-based claim: rows stay undispatched until mark_outbox_dispatched, so a crashed worker's
-- claims are retried after the lease expires (consumers are idempotent by event id).
CREATE OR REPLACE FUNCTION claim_outbox(p_limit int, p_lease interval DEFAULT interval '60 seconds')
RETURNS TABLE (id uuid, tenant_id uuid, topic text, payload jsonb, causation_id uuid, correlation_id uuid, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  UPDATE outbox o SET claimed_at = now()
  WHERE o.id IN (
    SELECT x.id FROM outbox x
    WHERE x.dispatched_at IS NULL AND (x.claimed_at IS NULL OR x.claimed_at < now() - p_lease)
    ORDER BY x.created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING o.id, o.tenant_id, o.topic, o.payload, o.causation_id, o.correlation_id, o.created_at
$$;

CREATE OR REPLACE FUNCTION mark_outbox_dispatched(p_ids uuid[])
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  UPDATE outbox SET dispatched_at = now() WHERE id = ANY(p_ids) AND dispatched_at IS NULL
$$;

REVOKE ALL ON FUNCTION claim_outbox(int, interval), mark_outbox_dispatched(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox(int, interval), mark_outbox_dispatched(uuid[]) TO abcrm_app;
