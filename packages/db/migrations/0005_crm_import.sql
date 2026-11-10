-- Migration 0005: M2 — CRM provenance, displayable suppression values, import commit/rollback tracking.
SET search_path = abcrm, public;

-- Where an account came from: {kind: manual|import|sourcing, import_job_id?, sourcing_run_id?}.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS source jsonb NOT NULL DEFAULT '{"kind":"manual"}';

-- Blind indexes cannot be reversed; keep the value encrypted so admins can see what is suppressed.
ALTER TABLE suppression_entries ADD COLUMN IF NOT EXISTS value_enc bytea;

ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS committed_at timestamptz;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS rolled_back_at timestamptz;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS filename text;
-- target_created distinguishes rows that created a record (rollback deletes it) from rows that matched one.
ALTER TABLE import_staging_rows ADD COLUMN IF NOT EXISTS target_created boolean NOT NULL DEFAULT false;
ALTER TABLE import_staging_rows ADD COLUMN IF NOT EXISTS normalized jsonb;

CREATE INDEX IF NOT EXISTS opportunities_account ON opportunities (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS staging_job_status ON import_staging_rows (tenant_id, job_id, status);
