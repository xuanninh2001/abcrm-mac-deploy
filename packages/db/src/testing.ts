// Test helpers. Each test file gets its own throwaway database, so packages can run in parallel.
// DATABASE_URL: superuser/migrator on any database of the test cluster.
// APP_DATABASE_URL: an abcrm_app member (NO BYPASSRLS); only its credentials are reused.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "./pool.js";
import { migrate } from "./migrate.js";

export type TestDb = {
  admin: Pool; app: Pool; global: Pool; adminUrl: string; tenantA: string; tenantB: string; close(): Promise<void>;
};

const withDatabase = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

export async function setupTestDb(): Promise<TestDb> {
  const baseAdmin = process.env.DATABASE_URL;
  const baseApp = process.env.APP_DATABASE_URL;
  if (!baseAdmin || !baseApp) throw new Error("DATABASE_URL and APP_DATABASE_URL are required for DB tests");

  const dbName = `abcrm_t_${randomBytes(6).toString("hex")}`;
  const maintenance = createPool(baseAdmin, 1);
  await maintenance.query(`CREATE DATABASE ${dbName}`);
  await maintenance.end();

  const adminUrl = withDatabase(baseAdmin, dbName);
  const admin = createPool(adminUrl, 3);
  await migrate(admin);   // creates the cluster-wide group roles on first run
  await admin.query(await readFile(fileURLToPath(new URL("../scripts/dev-roles.sql", import.meta.url)), "utf8"));
  await admin.query(`INSERT INTO abcrm.plan_entitlements VALUES
    ('trial', '{S1,S2,Q1,W1,I1}', 1000, 50, 2, 2, 5, '6 hours', 'medium', false, 50, now())
    ON CONFLICT DO NOTHING`);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  await admin.query("INSERT INTO abcrm.tenants(id, name, slug) VALUES ($1, 'Tenant A', $3), ($2, 'Tenant B', $4)", [
    tenantA, tenantB, `a-${tenantA.slice(0, 8)}`, `b-${tenantB.slice(0, 8)}`,
  ]);
  const app = createPool(withDatabase(baseApp, dbName), 5);
  // Worker-only role for global tables (public page cache, politeness state); dev-roles.sql credentials.
  const g = new URL(withDatabase(baseApp, dbName));
  g.username = "abcrm_global_user";
  g.password = "abcrm_global_pw";
  const global = createPool(g.toString(), 3);

  return {
    admin, app, global, adminUrl, tenantA, tenantB,
    async close() {
      await app.end();
      await global.end();
      await admin.end();
      // Plain DROP first so clients that are still closing (e.g. a workflow engine's pool) finish cleanly;
      // FORCE would terminate them mid-close and surface as an unhandled 57P01 in the test runner.
      const m = createPool(baseAdmin, 1);
      for (let i = 0; ; i++) {
        try { await m.query(`DROP DATABASE IF EXISTS ${dbName}`); break; } catch (e) {
          if ((e as { code?: string }).code !== "55006" || i >= 50) { await m.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); break; }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      await m.end();
    },
  };
}
