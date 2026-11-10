import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export function generateKey(): Buffer {
  return randomBytes(32);
}

/**
 * AES-256-GCM. Output layout: version(1) | iv(12) | tag(16) | ciphertext.
 * `aad` binds the ciphertext to its location (e.g. "<tenantId>:contacts.email") so a value
 * copied to another tenant or column fails to decrypt.
 */
export function encryptField(key: Buffer, plaintext: string, aad: string): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decryptField(key: Buffer, blob: Buffer, aad: string): string {
  assertKey(key);
  if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) throw new Error("decryptField: unsupported format");
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}

/** Deterministic HMAC-SHA256 for exact-match lookups (blind index). Normalize the value first. */
export function blindIndex(key: Buffer, purpose: string, normalized: string): Buffer {
  assertKey(key);
  return createHmac("sha256", key).update(`${purpose}\u0000${normalized}`, "utf8").digest();
}

export function equalBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
}
