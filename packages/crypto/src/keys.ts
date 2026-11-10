import { generateKey } from "./field.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Wraps/unwraps tenant data keys using a configured master key provider. */
export interface KeyProvider {
  readonly keyRef: string;
  wrap(dataKey: Buffer, context: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: string): Promise<Buffer>;
}

/** AES-256-GCM wrapping with a master key held in the hosting secret store. */
export class SecretKeyProvider implements KeyProvider {
  constructor(private readonly masterKey: Buffer, readonly keyRef = "secret:v1") {
    if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  }

  static fromEnv(env = process.env): SecretKeyProvider {
    const b64 = env.ABCRM_MASTER_KEY;
    if (!b64 || !/^[A-Za-z0-9+/]{43}=$/.test(b64) || Buffer.from(b64, "base64").toString("base64") !== b64) {
      throw new Error("ABCRM_MASTER_KEY must be 32 random bytes encoded as canonical base64");
    }
    return new SecretKeyProvider(Buffer.from(b64, "base64"));
  }

  async wrap(dataKey: Buffer, context: string): Promise<Buffer> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.masterKey, iv);
    c.setAAD(Buffer.from(context));
    const ct = Buffer.concat([c.update(dataKey), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  async unwrap(wrapped: Buffer, context: string): Promise<Buffer> {
    const d = createDecipheriv("aes-256-gcm", this.masterKey, wrapped.subarray(0, 12));
    d.setAAD(Buffer.from(context));
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}

/** Development only: retains the existing local key reference and fallback. */
export class LocalKeyProvider extends SecretKeyProvider {
  constructor(masterKey: Buffer) { super(masterKey, "local:dev"); }

  static override fromEnv(env = process.env): LocalKeyProvider {
    if (env.NODE_ENV === "production") throw new Error("LocalKeyProvider is not allowed in production");
    const b64 = env.ABCRM_DEV_MASTER_KEY;
    return new LocalKeyProvider(b64 ? Buffer.from(b64, "base64") : Buffer.alloc(32, 7));
  }
}

export { generateKey };
