SET search_path = abcrm, public;

-- Authentication secrets are not accessible through tenant CRUD or generic table grants.
CREATE TABLE local_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE local_sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX local_sessions_user ON local_sessions(user_id);
REVOKE ALL ON local_credentials, local_sessions FROM PUBLIC, abcrm_app, abcrm_global;
ALTER TABLE local_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY credentials_private ON local_credentials USING (false) WITH CHECK (false);
ALTER TABLE local_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_private ON local_sessions USING (false) WITH CHECK (false);

-- Locking the user before the credential serializes login with disable/reset.
CREATE FUNCTION local_revoke_user_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.role IS DISTINCT FROM OLD.role THEN
    DELETE FROM local_sessions WHERE user_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION local_revoke_user_sessions() FROM PUBLIC;
CREATE TRIGGER local_user_sessions AFTER UPDATE OF status, role ON users
  FOR EACH ROW EXECUTE FUNCTION local_revoke_user_sessions();

CREATE FUNCTION local_login_user(p_slug text, p_email text)
RETURNS TABLE(user_id uuid, email text, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  SELECT u.id, u.email, c.password_hash FROM users u
  JOIN tenants t ON t.id=u.tenant_id JOIN local_credentials c ON c.user_id=u.id
  WHERE t.slug=p_slug AND lower(u.email)=lower(p_email)
    AND t.status='active' AND u.status='active'
$$;

CREATE FUNCTION local_create_session(p_user uuid, p_password_hash text, p_token_hash bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=p_user FOR UPDATE;
  PERFORM 1 FROM local_credentials c JOIN users u ON u.id=c.user_id JOIN tenants t ON t.id=u.tenant_id
    WHERE c.user_id=p_user AND c.password_hash=p_password_hash AND u.status='active' AND t.status='active'
    FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM local_sessions WHERE expires_at <= now();
  INSERT INTO local_sessions(token_hash,user_id,expires_at) VALUES(p_token_hash,p_user,now()+interval '14 days');
  RETURN true;
END $$;

CREATE FUNCTION resolve_local_session(p_token_hash bytea)
RETURNS TABLE(tenant_id uuid, user_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  SELECT u.tenant_id,u.id,u.role FROM local_sessions s JOIN users u ON u.id=s.user_id
  JOIN tenants t ON t.id=u.tenant_id
  WHERE s.token_hash=p_token_hash AND s.expires_at>now() AND u.status='active' AND t.status='active'
$$;
CREATE FUNCTION local_logout(p_token_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  DELETE FROM local_sessions WHERE token_hash=p_token_hash
$$;
CREATE FUNCTION local_change_password(p_token_hash bytea,p_old text,p_new text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
DECLARE uid uuid;
BEGIN
  SELECT user_id INTO uid FROM resolve_local_session(p_token_hash);
  IF uid IS NULL THEN RETURN false; END IF;
  UPDATE local_credentials SET password_hash=p_new,updated_at=now() WHERE user_id=uid AND password_hash=p_old;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM local_sessions WHERE user_id=uid;
  RETURN true;
END $$;
CREATE FUNCTION local_session_credential(p_token_hash bytea) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
  SELECT c.password_hash FROM local_credentials c JOIN resolve_local_session(p_token_hash) s ON c.user_id=s.user_id
$$;
REVOKE ALL ON FUNCTION local_login_user(text,text), local_create_session(uuid,text,bytea),
  resolve_local_session(bytea),local_logout(bytea),local_change_password(bytea,text,text),local_session_credential(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION local_login_user(text,text), local_create_session(uuid,text,bytea),
  resolve_local_session(bytea),local_logout(bytea),local_change_password(bytea,text,text),local_session_credential(bytea) TO abcrm_app;

-- Only initialize an invited account in the caller's tenant; existing passwords use the admin CLI.
CREATE FUNCTION local_initialize_user(p_user uuid,p_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = abcrm, pg_temp AS $$
DECLARE caller_role text; target_role text;
BEGIN
  SELECT role INTO caller_role FROM users
    WHERE tenant_id=current_tenant_id() AND 'user:'||id::text=current_setting('app.actor',true) AND status='active';
  IF caller_role IS NULL OR caller_role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
  SELECT role INTO target_role FROM users WHERE id=p_user AND tenant_id=current_tenant_id() AND status='invited' FOR UPDATE;
  IF target_role IS NULL OR (target_role='owner' AND caller_role<>'owner') THEN RAISE EXCEPTION 'Permission denied' USING ERRCODE='42501'; END IF;
  INSERT INTO local_credentials(user_id,password_hash) VALUES(p_user,p_hash);
  UPDATE users SET status='active',activated_at=now() WHERE id=p_user;
END $$;
REVOKE ALL ON FUNCTION local_initialize_user(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION local_initialize_user(uuid,text) TO abcrm_app;
