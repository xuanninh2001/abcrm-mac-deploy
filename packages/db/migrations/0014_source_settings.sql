SET search_path = abcrm, public;
CREATE TABLE source_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL CHECK(provider IN ('brave','tavily','hunter')),
  enabled boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 10 CHECK(priority BETWEEN 1 AND 100),
  api_key_enc bytea,
  usage_allowed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,provider)
);
ALTER TABLE source_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_settings
 USING(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON source_settings TO abcrm_app;
