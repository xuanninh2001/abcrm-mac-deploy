-- RLS smoke test for schema.sql (run as superuser after loading schema; expects the ERRORs noted)
-- Expected: B sees 0 of A's accounts; cross-tenant INSERT fails RLS; no-context sees 0;
--           abcrm_app denied on public_pages; criteria insert on active playbook raises 'immutable'.
\set ON_ERROR_STOP 0
SET search_path = abcrm, public;
CREATE ROLE abcrm_app LOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA abcrm TO abcrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA abcrm TO abcrm_app;
REVOKE ALL ON data_providers, licensed_contact_cache, global_data_suppression, public_pages FROM abcrm_app;
INSERT INTO plan_entitlements VALUES ('trial','{S1,S2,Q1,W1}',1000,50,2,2,5,'6 hours','medium',false,50,now());
INSERT INTO tenants(id,name,slug) VALUES ('00000000-0000-0000-0000-00000000000a','A','a'),('00000000-0000-0000-0000-00000000000b','B','b');
SET ROLE abcrm_app;
-- tenant A context
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a',true);
INSERT INTO accounts(id,tenant_id,name,domain,domain_bidx) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','Acme','acme.com','\x01');
SELECT 'A sees tenants', count(*) FROM tenants;
COMMIT;
-- tenant B context: cannot see A's account, cannot write as A
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000b',true);
SELECT 'B sees A accounts', count(*) FROM accounts;
INSERT INTO accounts(id,tenant_id,name,domain,domain_bidx) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','Evil','evil.com','\x02');
ROLLBACK;
-- no context: sees nothing
SELECT 'no ctx accounts', count(*) FROM accounts;
-- global table blocked
SELECT count(*) FROM public_pages;
-- criteria immutability
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a',true);
INSERT INTO playbooks(id,tenant_id,lineage_id,name,version,status,definition_hash) VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-00000000000a',gen_random_uuid(),'P',1,'active','h');
COMMIT;
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a',true);
INSERT INTO criteria(id,tenant_id,playbook_id,key,name,description,kind,evaluation,order_no) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-000000000011','k','n','d','scored','ai_judged',1);
ROLLBACK;
