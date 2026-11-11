import { emitKeypressEvents } from "node:readline";
import { createPool } from "../src/pool.js";
import { createTenant } from "../src/tenants.js";
import { setLocalPassword } from "../src/local-password.js";
import { hashPassword, validatePassword } from "../../crypto/src/password.js";

async function secret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) throw new Error("Use an interactive terminal (docker compose run --rm -it). Passwords are never command-line arguments.");
  process.stdout.write(prompt);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve,reject) => {
    let value = "";
    const finish = () => { input.off("keypress", onKey); input.setRawMode(false); input.pause(); process.stdout.write("\n"); };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") { finish(); reject(new Error("Cancelled")); }
      else if (key.name === "return" || key.name === "enter") { finish(); resolve(value); }
      else if (key.name === "backspace") value = Array.from(value).slice(0,-1).join("");
      else if (text && !key.ctrl && !/[\x00-\x1f\x7f]/.test(text) && value.length < 512) value += text;
    };
    input.on("keypress", onKey);
  });
}

const [slug,email,flag] = process.argv.slice(2);
if (!slug || !email || (flag && flag !== "--create-tenant") || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  throw new Error("Usage: node --import tsx packages/db/scripts/local-password.ts <workspace-slug> <email> [--create-tenant]");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL (administrator) is required");
const password = await secret("New password (12+ characters, hidden): ");
validatePassword(password);
if (password !== await secret("Confirm password: ")) throw new Error("Passwords do not match");
const hash = await hashPassword(password);
const pool = createPool(process.env.DATABASE_URL, 2);
try {
  if (flag === "--create-tenant") {
    const existing = await pool.query("SELECT id FROM abcrm.tenants WHERE slug=$1", [slug]);
    if (!existing.rowCount) await createTenant(pool, { name: slug, slug, country: "VN", owner: { email } });
  }
  await setLocalPassword(pool, slug, email, hash);
  console.log("Password set. Previous internal sessions revoked. Sign in with your workspace, email and new password.");
} finally { await pool.end(); }
