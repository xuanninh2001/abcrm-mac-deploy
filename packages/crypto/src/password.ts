import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const derive = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
});
export function validatePassword(password: string): void {
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 256) throw new Error("Password must be at least 12 characters and at most 256 UTF-8 bytes");
}
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  return `scrypt-v1$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > 256) return false;
  const parts = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!parts) return false;
  return timingSafeEqual(await derive(password, Buffer.from(parts[1]!, "hex")), Buffer.from(parts[2]!, "hex"));
}
// Fixed, non-secret dummy credential equalizes unknown-account password work.
export const DUMMY_PASSWORD_HASH = `scrypt-v1$${"00".repeat(16)}$${"00".repeat(64)}`;
