import { createPool } from "../src/pool.js";
import { migrate } from "../src/migrate.js";
import { checkRlsCoverage } from "../src/rls-coverage.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const credentials = [
  ["abcrm_app_user", "APP_DB_PASSWORD", "abcrm_app"],
  ["abcrm_global_user", "GLOBAL_DB_PASSWORD", "abcrm_global"],
  ["abcrm_dbos_user", "DBOS_DB_PASSWORD", null],
] as const;
for (const [, key] of credentials) {
  if (!/^[a-f0-9]{64}$/.test(process.env[key] ?? "")) throw new Error(`${key} must be 64 hex characters`);
}
const pool = createPool(url, 1);
try {
  // Serialize first-start migration and role creation across concurrent launches.
  await pool.query("SELECT pg_advisory_lock(7382041)");
  console.log("Migrations:", await migrate(pool));
  for (const [role, key, group] of credentials) {
    const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
    const password = process.env[key]!;
    await pool.query(`${exists.rowCount ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    if (group) await pool.query(`GRANT ${group} TO ${role}`);
  }
  const db = await pool.query("SELECT 1 FROM pg_database WHERE datname='abcrm_dbos'");
  if (!db.rowCount) await pool.query("CREATE DATABASE abcrm_dbos OWNER abcrm_dbos_user");
  await pool.query("ALTER DATABASE abcrm_dbos OWNER TO abcrm_dbos_user");
  const problems = await checkRlsCoverage(pool);
  if (problems.length) throw new Error(JSON.stringify(problems));
  console.log("Database bootstrap complete; RLS coverage ok");
} finally {
  await pool.query("SELECT pg_advisory_unlock(7382041)").catch(() => {});
  await pool.end();
}
