import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./pool.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await pool.query<{ version: string }>("SELECT version FROM public.schema_migrations");
  const applied = new Set(rows.map((r) => r.version));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO public.schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ran.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return ran;
}

/** Drops the application schema. Local/test only. */
export async function reset(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS abcrm CASCADE");
  await pool.query("DROP TABLE IF EXISTS public.schema_migrations");
}
