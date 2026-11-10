import { createPool } from "./pool.js";
import { migrate, reset } from "./migrate.js";
import { exitCriteriaReport, formatReport } from "./exit-criteria.js";
import { createTenant } from "./tenants.js";
import { checkRlsCoverage } from "./rls-coverage.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const pool = createPool(url, 1);
const cmd = process.argv[2];

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

try {
  if (cmd === "tenant:create") {
    // pnpm tenant:create --name "Acme Leads" --slug acme --owner-email owner@acme.vn [--owner-name ..] [--plan trial] [--country VN] [--workos-org org_..]
    const need = (n: string) => arg(n) ?? (() => { throw new Error(`${n} is required`); })();
    const r = await createTenant(pool, { name: need("--name"), slug: need("--slug"), plan: arg("--plan"), country: arg("--country"),
      workosOrgId: arg("--workos-org"), owner: { email: need("--owner-email"), name: arg("--owner-name"), timezone: arg("--owner-timezone") } });
    console.log(JSON.stringify(r));
  } else if (cmd === "rls-check") {
    // Read-only: every tenant table has FORCE RLS and its policy; partitions are not reachable by the app role.
    const problems = await checkRlsCoverage(pool);
    for (const p of problems) console.error(`✗ ${p.table}: ${p.problem}`);
    console.log(problems.length ? `${problems.length} problem(s)` : "RLS coverage ok");
    process.exitCode = problems.length ? 1 : 0;
  } else if (cmd === "report") {
    // pnpm report:exit-criteria [--since YYYY-MM-DD] [--tenant <id>] [--json]
    const since = arg("--since");
    const reports = await exitCriteriaReport(pool, { since: since ? new Date(since) : undefined, tenantId: arg("--tenant") });
    console.log(process.argv.includes("--json") ? JSON.stringify(reports, null, 2) : formatReport(reports));
  } else {
    if (cmd === "reset") {
      if (process.env.NODE_ENV === "production") throw new Error("refusing to reset in production");
      await reset(pool);
    }
    const ran = await migrate(pool);
    console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
  }
} finally {
  await pool.end();
}
