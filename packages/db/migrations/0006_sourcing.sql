-- Migration 0006: M3 sourcing — page text in the public cache, global per-domain politeness, run/candidate bookkeeping.
SET search_path = abcrm, public;

-- Extracted text lives in the row until object storage is wired (then content_ref takes over).
ALTER TABLE public_pages ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE public_pages ADD COLUMN IF NOT EXISTS content_text text;
ALTER TABLE public_pages ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]';
ALTER TABLE public_pages ADD COLUMN IF NOT EXISTS tech_signals jsonb NOT NULL DEFAULT '{}';

-- Global (all tenants) politeness: one request per domain per interval, whoever asks (ADR-014).
CREATE TABLE IF NOT EXISTS domain_fetch_state (
  domain          text PRIMARY KEY,
  next_allowed_at timestamptz NOT NULL,
  last_status     int
);
REVOKE ALL ON domain_fetch_state FROM abcrm_app;
GRANT SELECT, INSERT, UPDATE ON domain_fetch_state TO abcrm_global;
GRANT SELECT, INSERT, UPDATE ON public_pages, robots_cache TO abcrm_global;

-- Search results cache (provider responses are public data; no tenant attribution).
CREATE TABLE IF NOT EXISTS search_cache (
  query_hash  bytea PRIMARY KEY,
  provider    text NOT NULL,
  results     jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
REVOKE ALL ON search_cache FROM abcrm_app;
GRANT SELECT, INSERT, UPDATE ON search_cache TO abcrm_global;

CREATE INDEX IF NOT EXISTS evidence_account_hash ON evidence (tenant_id, account_id, content_hash);
