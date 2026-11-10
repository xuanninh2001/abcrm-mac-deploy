-- Migration 0002: application roles, grants, auth resolver functions.
-- Roles are NOLOGIN group roles; environments create LOGIN members (see scripts/dev-roles.sql).
SET search_path = abcrm, public;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abcrm_app') THEN
    CREATE ROLE abcrm_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abcrm_global') THEN
    CREATE ROLE abcrm_global NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA abcrm TO abcrm_app, abcrm_global;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA abcrm TO abcrm_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA abcrm TO abcrm_app;

-- Global tables: worker-only role.
REVOKE ALL ON data_providers, licensed_contact_cache, global_data_suppression,
              public_pages, robots_cache, crawl_policy, global_contact_pressure,
              agent_templates, plan_entitlements FROM abcrm_app;
GRANT SELECT ON plan_entitlements, agent_templates, crawl_policy TO abcrm_app;
GRANT SELECT, INSERT, UPDATE ON data_providers, licensed_contact_cache, global_data_suppression,
              public_pages, robots_cache, global_contact_pressure TO abcrm_global;
GRANT SELECT ON crawl_policy, plan_entitlements, agent_templates TO abcrm_global;

-- Append-only tables.
REVOKE UPDATE, DELETE ON audit_log, usage_events, scorecards, criterion_results FROM abcrm_app;

-- Tenant bootstrap is done by the migrator/admin connection, not abcrm_app.
REVOKE INSERT, DELETE ON tenants FROM abcrm_app;

-- Auth resolvers: run before tenant context exists, so they bypass RLS via SECURITY DEFINER
-- and return only what the auth middleware needs.
CREATE OR REPLACE FUNCTION resolve_api_key(p_key_hash bytea)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  SELECT k.id, k.tenant_id, k.scopes
  FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
  WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL AND t.status = 'active'
$$;

CREATE OR REPLACE FUNCTION resolve_workos_identity(p_org_id text, p_user_id text)
RETURNS TABLE (tenant_id uuid, user_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  SELECT u.tenant_id, u.id, u.role
  FROM users u JOIN tenants t ON t.id = u.tenant_id
  WHERE t.workos_org_id = p_org_id AND u.workos_user_id = p_user_id
    AND u.status = 'active' AND t.status = 'active'
$$;

REVOKE ALL ON FUNCTION resolve_api_key(bytea), resolve_workos_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(bytea), resolve_workos_identity(text, text) TO abcrm_app;
