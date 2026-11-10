import { createHmac } from "node:crypto";
import { decryptField, encryptField } from "@abcrm/crypto";

/**
 * Platform-level keys for the global contact layer (ADR-015): an HMAC key for global blind indexes
 * (domain, email, person key) and an AES key for the licensed cache. They are not tenant keys: the cache
 * and global suppression never record which tenant asked.
 */
export class PlatformKeys {
  constructor(private readonly hmacKey: Buffer, private readonly cacheKey: Buffer) {
    if (hmacKey.length !== 32 || cacheKey.length !== 32) throw new Error("platform keys must be 32 bytes");
  }

  static fromEnv(env = process.env): PlatformKeys {
    const h = env.ABCRM_PLATFORM_HMAC_KEY;
    const c = env.ABCRM_PLATFORM_CACHE_KEY;
    if (h && c) return new PlatformKeys(Buffer.from(h, "base64"), Buffer.from(c, "base64"));
    if (env.NODE_ENV === "production") throw new Error("ABCRM_PLATFORM_HMAC_KEY and ABCRM_PLATFORM_CACHE_KEY are required in production");
    return new PlatformKeys(Buffer.alloc(32, 11), Buffer.alloc(32, 13));
  }

  ghmac(kind: "email" | "domain" | "person_key", normalized: string): Buffer {
    return createHmac("sha256", this.hmacKey).update(`${kind}\u0000${normalized}`, "utf8").digest();
  }

  sealCache(providerKey: string, payload: unknown): Buffer {
    return encryptField(this.cacheKey, JSON.stringify(payload), `lcc:${providerKey}`);
  }

  openCache<T>(providerKey: string, blob: Buffer): T {
    return JSON.parse(decryptField(this.cacheKey, blob, `lcc:${providerKey}`)) as T;
  }
}

/** Stable person identity across providers: normalized full name + company domain. */
export const personKey = (firstName: string, lastName: string, domain: string) =>
  `${firstName.trim().toLowerCase()} ${lastName.trim().toLowerCase()}@${domain}`;
