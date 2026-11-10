import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM sealing for the session cookie (iron-session style, no dependency). */
export function seal(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function unseal<T>(key: Buffer, sealed: string | undefined): T | null {
  if (!sealed) return null;
  try {
    const b = Buffer.from(sealed, "base64url");
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as T;
  } catch {
    return null;   // tampered, rotated key or garbage → treated as signed out
  }
}

/** Expiry (seconds since epoch) of a JWT, without verifying it (the API verifies). */
export function jwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
