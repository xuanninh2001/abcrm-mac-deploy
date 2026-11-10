-- Migration 0008: M5 — plan seeds and overage pricing, card snooze, supersede/expiry, email-draft invariant.
SET search_path = abcrm, public;

-- Overage pricing per plan (pricing doc §2; illustrative until the cost spike). Spend cap NULL = no cap.
ALTER TABLE plan_entitlements ADD COLUMN IF NOT EXISTS overage_agent_unit_usd   numeric(10,6) NOT NULL DEFAULT 0.012;
ALTER TABLE plan_entitlements ADD COLUMN IF NOT EXISTS overage_contact_unit_usd numeric(10,6) NOT NULL DEFAULT 0.30;
ALTER TABLE plan_entitlements ADD COLUMN IF NOT EXISTS spend_cap_default_usd    numeric(10,2);

INSERT INTO plan_entitlements(plan, template_keys, included_agent_credits, included_contact_credits, max_concurrency, max_active_monitors,
  max_mailboxes, min_poll_interval, max_model_tier, overage_default, spend_cap_default_pct, overage_agent_unit_usd, overage_contact_unit_usd, spend_cap_default_usd)
VALUES
  ('trial',      '{S1,S2,Q1,W1,I1}', 1000,  50,   2,  2,   5, '6 hours', 'medium', false, 50, 0.012, 0.30, NULL),
  ('starter',    '{S1,S2,Q1,W1,I1}', 3000,  200,  2,  2,   5, '6 hours', 'medium', false, 50, 0.012, 0.30, NULL),
  ('growth',     '{S1,S2,Q1,W1,I1}', 15000, 1000, 6,  10,  25, '3 hours', 'medium', true,  50, 0.010, 0.25, 59.00),
  ('scale',      '{S1,S2,Q1,W1,I1}', 50000, 4000, 20, 40, 100, '1 hour',  'large',  true,  50, 0.008, 0.20, 297.50),
  ('enterprise', '{S1,S2,Q1,W1,I1}', 50000, 4000, 50, 100, 500, '1 hour', 'large',  true,  50, 0.008, 0.20, NULL)
ON CONFLICT (plan) DO NOTHING;

-- Rejected cards put the account on a cooldown (decision-inbox.md §2.2); sourcing dedupes it as recently_contacted.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cooldown_until timestamptz;

-- Snooze keeps a card pending but out of the inbox until the given time.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
CREATE INDEX IF NOT EXISTS decisions_expiry ON decisions (expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_drafts_decision ON email_drafts (decision_id);

-- Exit criterion (README §4): no path sets an email draft to approved without an approved G-Q on the same card.
CREATE OR REPLACE FUNCTION email_draft_requires_gq() RETURNS trigger LANGUAGE plpgsql
SET search_path = abcrm, pg_temp AS $$
BEGIN
  IF NEW.status IN ('approved', 'edited', 'queued', 'sent') AND NOT EXISTS (
       SELECT 1 FROM decisions gout JOIN decisions gq ON gq.card_id = gout.card_id AND gq.tenant_id = gout.tenant_id
       WHERE gout.id = NEW.decision_id AND gq.gate_id = 'G-Q' AND gq.status IN ('approved', 'edited', 'executed')) THEN
    RAISE EXCEPTION 'email draft % cannot be % without an approved G-Q decision', NEW.id, NEW.status;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_email_draft_requires_gq ON email_drafts;
CREATE TRIGGER trg_email_draft_requires_gq BEFORE INSERT OR UPDATE OF status ON email_drafts
  FOR EACH ROW EXECUTE FUNCTION email_draft_requires_gq();

-- Supersede (decision-inbox.md §2.1): pending cards disappear when the account is flagged/blocked or a proposed
-- contact is suppressed. A trigger covers every path (API, import, suppression propagation).
CREATE OR REPLACE FUNCTION supersede_card(p_tenant uuid, p_card uuid, p_reason text) RETURNS void LANGUAGE plpgsql
SET search_path = abcrm, pg_temp AS $$
DECLARE d record;
BEGIN
  FOR d IN UPDATE decisions SET status = 'superseded', reject_note = p_reason
           WHERE tenant_id = p_tenant AND card_id = p_card AND status = 'pending' RETURNING id, gate_id, subject_id LOOP
    INSERT INTO outbox(id, tenant_id, topic, payload)
      VALUES (gen_random_uuid(), p_tenant, 'decisions.decision.superseded', jsonb_build_object('decision_id', d.id, 'reason', p_reason, 'card_id', p_card));
    IF d.gate_id = 'G-Q' THEN
      UPDATE accounts SET status = 'prospect' WHERE id = d.subject_id AND status = 'carded';
      UPDATE candidates SET status = 'scored' WHERE decision_id = d.id AND status = 'carded';
    END IF;
  END LOOP;
  UPDATE email_drafts SET status = 'rejected'
   WHERE tenant_id = p_tenant AND status = 'proposed' AND decision_id IN (SELECT id FROM decisions WHERE card_id = p_card);
END $$;

CREATE OR REPLACE FUNCTION supersede_on_account_change() RETURNS trigger LANGUAGE plpgsql
SET search_path = abcrm, pg_temp AS $$
DECLARE c uuid;
BEGIN
  IF (NEW.flags && ARRAY['competitor','existing_buyer','do_not_contact'] AND NOT (OLD.flags && ARRAY['competitor','existing_buyer','do_not_contact']))
     OR (NEW.status = 'blocked' AND OLD.status <> 'blocked') THEN
    FOR c IN SELECT DISTINCT card_id FROM decisions WHERE tenant_id = NEW.tenant_id AND subject_type = 'account' AND subject_id = NEW.id
             AND status = 'pending' AND card_id IS NOT NULL LOOP
      PERFORM supersede_card(NEW.tenant_id, c, 'account_flagged');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_supersede_on_account_change ON accounts;
CREATE TRIGGER trg_supersede_on_account_change AFTER UPDATE OF flags, status ON accounts
  FOR EACH ROW EXECUTE FUNCTION supersede_on_account_change();

CREATE OR REPLACE FUNCTION supersede_on_contact_suppressed() RETURNS trigger LANGUAGE plpgsql
SET search_path = abcrm, pg_temp AS $$
DECLARE c uuid;
BEGIN
  IF NEW.status <> 'active' AND OLD.status = 'active' THEN
    FOR c IN SELECT DISTINCT card_id FROM decisions WHERE tenant_id = NEW.tenant_id AND gate_id = 'G-Q' AND status = 'pending'
             AND action->'args'->'contacts' @> jsonb_build_array(jsonb_build_object('contactId', NEW.id::text)) LOOP
      PERFORM supersede_card(NEW.tenant_id, c, 'contact_suppressed');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_supersede_on_contact_suppressed ON contacts;
CREATE TRIGGER trg_supersede_on_contact_suppressed AFTER UPDATE OF status ON contacts
  FOR EACH ROW EXECUTE FUNCTION supersede_on_contact_suppressed();

-- Expiry sweep across tenants (worker, scheduled). SECURITY DEFINER like claim_outbox: it touches only due rows
-- and leaves the per-tenant follow-up (account status, events) to the trigger-safe helper above.
CREATE OR REPLACE FUNCTION expire_due_decisions(p_limit int DEFAULT 500)
RETURNS TABLE(tenant_id uuid, decision_id uuid, card_id uuid) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = abcrm, pg_temp AS $$
#variable_conflict use_column
DECLARE r record;
BEGIN
  FOR r IN SELECT d.tenant_id, d.id, d.card_id, d.gate_id, d.subject_id FROM decisions d
           WHERE d.status = 'pending' AND d.expires_at IS NOT NULL AND d.expires_at < now()
           ORDER BY d.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE decisions SET status = 'expired' WHERE id = r.id;
    INSERT INTO outbox(id, tenant_id, topic, payload) VALUES (gen_random_uuid(), r.tenant_id, 'decisions.decision.expired', jsonb_build_object('decision_id', r.id));
    IF r.gate_id = 'G-Q' THEN
      UPDATE accounts SET status = 'prospect' WHERE id = r.subject_id AND status = 'carded';
      UPDATE candidates SET status = 'scored' WHERE decision_id = r.id AND status IN ('carded', 'snoozed');
    END IF;
    IF r.gate_id = 'G-OUT' THEN
      UPDATE email_drafts SET status = 'rejected' WHERE decision_id = r.id AND status = 'proposed';
    END IF;
    tenant_id := r.tenant_id; decision_id := r.id; card_id := r.card_id;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION expire_due_decisions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_due_decisions(int) TO abcrm_app;
