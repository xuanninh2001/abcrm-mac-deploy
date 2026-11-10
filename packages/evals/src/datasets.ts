import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DATASETS_DIR = fileURLToPath(new URL("../datasets", import.meta.url));

/** JSON Lines; blank lines and lines starting with // are ignored. Each record is checked by the suite that reads it. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").map((l, i) => [l.trim(), i + 1] as const).filter(([l]) => l && !l.startsWith("//")).map(([l, n]) => {
    try { return JSON.parse(l) as T; } catch { throw new Error(`${path}:${n}: invalid JSON`); }
  });
}

export async function listFiles(dir: string, ext = ".jsonl"): Promise<string[]> {
  try { return (await readdir(dir)).filter((f) => f.endsWith(ext)).sort().map((f) => `${dir}/${f}`); } catch { return []; }
}
