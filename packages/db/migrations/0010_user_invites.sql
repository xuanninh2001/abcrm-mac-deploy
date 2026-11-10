-- Migration 0010: user invites. An invited user has a placeholder workos_user_id ('invite:<id>') until their
-- first WorkOS sign-in binds the real one; emails are matched case-insensitively.
SET search_path = abcrm, public;

UPDATE users SET email = lower(email) WHERE email <> lower(email);
ALTER TABLE users ADD CONSTRAINT users_email_lower CHECK (email = lower(email));
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- Runs before tenant context exists (first sign-in), so it bypasses RLS. The caller must pass an email that
-- WorkOS reports as verified for p_user_id; only a pending invite in the token's organization is bound.
CREATE OR REPLACE FUNCTION activate_workos_invite(p_org_id text, p_user_id text, p_email text)
RETURNS TABLE (tenant_id uuid, user_id uuid, role text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  UPDATE users u SET workos_user_id = p_user_id, status = 'active', activated_at = now()
  FROM tenants t
  WHERE t.id = u.tenant_id AND t.workos_org_id = p_org_id AND t.status = 'active'
    AND u.status = 'invited' AND u.email = lower(p_email)
    AND NOT EXISTS (SELECT 1 FROM users x WHERE x.tenant_id = u.tenant_id AND x.workos_user_id = p_user_id)
  RETURNING u.tenant_id, u.id, u.role
$$;
REVOKE ALL ON FUNCTION activate_workos_invite(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_workos_invite(text, text, text) TO abcrm_app;
