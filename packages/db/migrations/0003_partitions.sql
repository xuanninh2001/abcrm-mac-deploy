-- Migration 0003: monthly partitions for partitioned tables (+ DEFAULT partition as safety net).
SET search_path = abcrm, public;

-- RLS policies are enforced when a partitioned table is accessed through its parent, but NOT when a
-- partition is queried directly. The app role must therefore have no privileges on partitions;
-- privileges on the parent are sufficient for INSERT/SELECT routed through it.
CREATE OR REPLACE FUNCTION revoke_partition_privileges() RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'abcrm' AND c.relispartition AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('REVOKE ALL ON %s FROM abcrm_app, abcrm_global, PUBLIC', r.rel);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ensure_monthly_partitions(p_table regclass, p_months_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  base text := split_part(p_table::text, '.', 2);
  m date;
  part text;
BEGIN
  IF base = '' THEN base := p_table::text; END IF;
  FOR i IN 0..p_months_ahead LOOP
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    part := format('%s_%s', base, to_char(m, 'YYYYMM'));
    EXECUTE format('CREATE TABLE IF NOT EXISTS abcrm.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                   part, p_table, m, (m + interval '1 month')::date);
  END LOOP;
  EXECUTE format('CREATE TABLE IF NOT EXISTS abcrm.%I PARTITION OF %s DEFAULT', base || '_default', p_table);
  PERFORM revoke_partition_privileges();
END $$;

SELECT ensure_monthly_partitions('abcrm.agent_steps');
SELECT ensure_monthly_partitions('abcrm.usage_events');
SELECT ensure_monthly_partitions('abcrm.cost_ledger');
SELECT ensure_monthly_partitions('abcrm.audit_log');

SELECT revoke_partition_privileges();
