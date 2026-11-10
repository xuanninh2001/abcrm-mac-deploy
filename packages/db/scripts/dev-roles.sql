-- Local/test only: LOGIN members of the group roles. Never run in production.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abcrm_app_user') THEN
    CREATE ROLE abcrm_app_user LOGIN PASSWORD 'abcrm_app_pw' IN ROLE abcrm_app;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abcrm_global_user') THEN
    CREATE ROLE abcrm_global_user LOGIN PASSWORD 'abcrm_global_pw' IN ROLE abcrm_global;
  END IF;
END $$;
