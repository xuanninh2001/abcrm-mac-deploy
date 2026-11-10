import type { Pool } from "./pool.js";

/** Tables intentionally without tenant isolation (ADR-014/015). Anything else must have forced RLS. */
export const GLOBAL_TABLES = new Set([
  "plan_entitlements", "agent_templates", "data_providers", "licensed_contact_cache", "global_data_suppression",
  "public_pages", "robots_cache", "crawl_policy", "global_contact_pressure", "domain_fetch_state", "search_cache",
]);

export type CoverageProblem = { table: string; problem: string };

/** test-plan.md §2.2: every non-global table must have FORCE RLS + tenant policy; partitions must not be directly accessible. */
export async function checkRlsCoverage(pool: Pool): Promise<CoverageProblem[]> {
  const { rows } = await pool.query<{
    table: string; rls: boolean; forced: boolean; partition: boolean; policies: number; app_privs: boolean;
  }>(`
    SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           c.relispartition AS partition,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
           has_table_privilege('abcrm_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_privs
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'abcrm' AND c.relkind IN ('r', 'p')`);

  const problems: CoverageProblem[] = [];
  for (const r of rows) {
    if (r.partition) {
      if (r.app_privs) problems.push({ table: r.table, problem: "abcrm_app can access partition directly (bypasses RLS)" });
      continue;
    }
    if (GLOBAL_TABLES.has(r.table)) continue;
    if (!r.rls || !r.forced) problems.push({ table: r.table, problem: "RLS not enabled+forced" });
    if (r.policies === 0) problems.push({ table: r.table, problem: "no RLS policy" });
  }
  return problems;
}
