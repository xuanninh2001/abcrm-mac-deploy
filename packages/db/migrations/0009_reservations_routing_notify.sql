-- Migration 0009: M5.1 — credit reservations, card routing/SLA escalation, notifications, criterion verification, usage reporting.
SET search_path = abcrm, public;

-- Reservations (pricing doc §4 steps 1–3): reserved credits count against the balance until committed or released.
ALTER TABLE usage_balances ADD COLUMN IF NOT EXISTS reserved numeric(12,1) NOT NULL DEFAULT 0 CHECK (reserved >= 0);
CREATE TABLE IF NOT EXISTS usage_reservations (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  period      date NOT NULL,
  meter       text NOT NULL CHECK (meter IN ('agent','contact')),
  credits     numeric(10,1) NOT NULL CHECK (credits > 0),
  status      text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','committed','released')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz,
  PRIMARY KEY (tenant_id, key)
);
SELECT enable_tenant_rls('usage_reservations', false);
CREATE INDEX IF NOT EXISTS usage_reservations_open ON usage_reservations (created_at) WHERE status = 'reserved';
GRANT SELECT, INSERT, UPDATE ON usage_reservations TO abcrm_app;

-- A crashed worker must not hold credits forever: release reservations older than p_age.
CREATE OR REPLACE FUNCTION release_stale_reservations(p_age interval DEFAULT '1 hour') RETURNS int LANGUAGE plpgsql SECURITY DEFINER
SET search_path = abcrm, pg_temp AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT tenant_id, key, period, meter, credits FROM usage_reservations
           WHERE status = 'reserved' AND created_at < now() - p_age FOR UPDATE SKIP LOCKED LOOP
    UPDATE usage_reservations SET status = 'released', settled_at = now() WHERE tenant_id = r.tenant_id AND key = r.key;
    UPDATE usage_balances SET reserved = greatest(0, reserved - r.credits) WHERE tenant_id = r.tenant_id AND period = r.period AND meter = r.meter;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION release_stale_reservations(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_stale_reservations(interval) TO abcrm_app;

-- Routing & SLA (decision-inbox.md §3): level 0 → overdue (notify) → level 1 → reassign/escalate → level 2.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS escalation_level int NOT NULL DEFAULT 0;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
CREATE INDEX IF NOT EXISTS decisions_assignee ON decisions (tenant_id, assignee_user_id, status) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION due_escalations(p_grace interval DEFAULT '4 hours', p_limit int DEFAULT 200)
RETURNS TABLE(tenant_id uuid, decision_id uuid, card_id uuid, level int) LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = abcrm, pg_temp AS $$
  SELECT d.tenant_id, d.id, d.card_id, d.escalation_level FROM decisions d
  WHERE d.status = 'pending' AND d.gate_id = 'G-Q' AND d.sla_due_at IS NOT NULL
    AND (d.snoozed_until IS NULL OR d.snoozed_until <= now())
    AND ((d.escalation_level = 0 AND d.sla_due_at < now()) OR (d.escalation_level = 1 AND d.sla_due_at + p_grace < now()))
  ORDER BY d.sla_due_at LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION due_escalations(interval, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION due_escalations(interval, int) TO abcrm_app;

-- In-app notifications; email delivery goes through the Mailer adapter (disabled until a provider key is set).
CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL,                     -- digest|card_overdue|card_assigned|card_escalated|billing_threshold|billing_exhausted|agent_paused
  title        text NOT NULL,
  body         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',       -- IDs only, no prospect PII
  read_at      timestamptz,
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sent','skipped','failed','none')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('notifications', false);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (tenant_id, user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON notifications TO abcrm_app;

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_digest_date date;
-- Users whose local time is in the 08:00 hour and who have not had today's digest.
CREATE OR REPLACE FUNCTION digest_due_users(p_limit int DEFAULT 500)
RETURNS TABLE(tenant_id uuid, user_id uuid, local_date date) LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = abcrm, pg_temp AS $$
  SELECT u.tenant_id, u.id, (now() AT TIME ZONE u.timezone)::date FROM users u JOIN tenants t ON t.id = u.tenant_id
  WHERE u.status = 'active' AND t.status = 'active' AND u.role IN ('sales_rep', 'head_of_bd', 'admin', 'owner')
    AND extract(hour FROM (now() AT TIME ZONE u.timezone)) = 8
    AND (u.last_digest_date IS NULL OR u.last_digest_date < (now() AT TIME ZONE u.timezone)::date)
  LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION digest_due_users(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION digest_due_users(int) TO abcrm_app;

-- "Mark as verified by me" (decision-inbox.md §1.1): a rep's note on an unknown criterion. Scorecards stay immutable.
CREATE TABLE IF NOT EXISTS criterion_verifications (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  scorecard_id  uuid NOT NULL REFERENCES scorecards(id),
  criterion_id  uuid NOT NULL REFERENCES criteria(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  note          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scorecard_id, criterion_id, user_id)
);
SELECT enable_tenant_rls('criterion_verifications', false);
GRANT SELECT, INSERT, UPDATE ON criterion_verifications TO abcrm_app;

-- Hourly usage reports to Stripe Meters (pricing doc §4 step 4). Quantities only, never PII.
CREATE TABLE IF NOT EXISTS usage_reports (
  identifier   text PRIMARY KEY,                   -- <tenant>:<meter>:<hour>, Stripe idempotency
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  meter        text NOT NULL CHECK (meter IN ('agent','contact')),
  hour         timestamptz NOT NULL,
  credits      numeric(12,1) NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reported','skipped','failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reported_at  timestamptz
);
SELECT enable_tenant_rls('usage_reports', false);
GRANT SELECT ON usage_reports TO abcrm_app;

-- Aggregates completed hours not yet reported, across tenants (worker only).
CREATE OR REPLACE FUNCTION claim_usage_reports(p_since timestamptz, p_limit int DEFAULT 500)
RETURNS TABLE(identifier text, tenant_id uuid, stripe_customer_id text, meter text, hour timestamptz, credits numeric) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = abcrm, pg_temp AS $$
#variable_conflict use_column
BEGIN
  INSERT INTO usage_reports(identifier, tenant_id, meter, hour, credits)
  SELECT e.tenant_id || ':' || e.meter || ':' || to_char(date_trunc('hour', e.occurred_at), 'YYYYMMDDHH24'), e.tenant_id, e.meter,
         date_trunc('hour', e.occurred_at), sum(e.credits)
  FROM usage_events e
  WHERE e.billable AND e.occurred_at >= p_since AND e.occurred_at < date_trunc('hour', now())
  GROUP BY e.tenant_id, e.meter, date_trunc('hour', e.occurred_at)
  ON CONFLICT (identifier) DO NOTHING;
  RETURN QUERY
    SELECT r.identifier, r.tenant_id, t.stripe_customer_id, r.meter, r.hour, r.credits FROM usage_reports r JOIN tenants t ON t.id = r.tenant_id
    WHERE r.status IN ('pending', 'failed') ORDER BY r.hour LIMIT p_limit;
END $$;
CREATE OR REPLACE FUNCTION mark_usage_report(p_identifier text, p_status text, p_error text DEFAULT NULL) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = abcrm, pg_temp AS $$
  UPDATE usage_reports SET status = p_status, error = p_error, reported_at = CASE WHEN p_status = 'reported' THEN now() ELSE reported_at END
  WHERE identifier = p_identifier
$$;
REVOKE ALL ON FUNCTION claim_usage_reports(timestamptz, int), mark_usage_report(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_usage_reports(timestamptz, int), mark_usage_report(text, text, text) TO abcrm_app;
