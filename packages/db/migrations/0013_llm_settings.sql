SET search_path = abcrm, public;
CREATE TABLE llm_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  mode text NOT NULL CHECK (mode IN ('environment', '9router', 'disabled')),
  base_url text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  api_key_enc bytea,
  json_mode boolean NOT NULL DEFAULT false,
  input_price numeric NOT NULL DEFAULT 0 CHECK (input_price >= 0),
  output_price numeric NOT NULL DEFAULT 0 CHECK (output_price >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE llm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON llm_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON llm_settings TO abcrm_app;
