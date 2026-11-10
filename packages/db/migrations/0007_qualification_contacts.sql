-- Migration 0007: M4 — qualification scorecards, playbook previews, contact lookup results.
SET search_path = abcrm, public;

-- What a lookup returned (title match, email status, charge) so a retried workflow step gets the same answer.
ALTER TABLE contact_lookups ADD COLUMN IF NOT EXISTS results jsonb NOT NULL DEFAULT '[]';

-- One scorecard per candidate and playbook version: Q1 retries return the existing one.
CREATE UNIQUE INDEX IF NOT EXISTS scorecards_candidate_playbook ON scorecards (tenant_id, candidate_id, playbook_id);
CREATE INDEX IF NOT EXISTS scorecards_account ON scorecards (tenant_id, account_id, created_at DESC);

-- Playbook preview (ipp-playbook-format.md §3.3): sample run of a draft playbook, attached to its G-T1.
CREATE TABLE IF NOT EXISTS playbook_previews (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  playbook_id       uuid NOT NULL REFERENCES playbooks(id),
  definition_hash   text NOT NULL,              -- preview is valid only for this criteria set
  sample            text NOT NULL CHECK (sample IN ('recent','golden')),
  sample_size       int  NOT NULL,
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  tier_distribution jsonb NOT NULL DEFAULT '{}', -- {A, B, C, D}
  results           jsonb NOT NULL DEFAULT '[]', -- [{account_id, domain, tier, pct, stopped_at, criteria:{key:{result, quotes}}}]
  error             text,
  agent_credits     numeric(10,1) NOT NULL DEFAULT 0,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
SELECT enable_tenant_rls('playbook_previews', false);
CREATE INDEX IF NOT EXISTS playbook_previews_playbook ON playbook_previews (tenant_id, playbook_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON playbook_previews TO abcrm_app;
