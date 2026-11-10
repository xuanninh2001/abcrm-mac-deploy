import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { KeyProvider } from "./keys.js";
import { LocalKeyProvider, SecretKeyProvider } from "./keys.js";

/** The subset of KMSClient we use; injectable for tests. */
export type KmsSend = (cmd: EncryptCommand | DecryptCommand) => Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }>;

/**
 * Wraps tenant data keys with an AWS KMS key. The context string (e.g. "tenant:<id>:dek") is passed as
 * KMS EncryptionContext, so a wrapped key copied to another tenant cannot be unwrapped, and every
 * unwrap is attributable in CloudTrail.
 */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly keyRef: string;
  private readonly send: KmsSend;

  constructor(private readonly keyId: string, opts: { region?: string; send?: KmsSend } = {}) {
    this.keyRef = `aws-kms:${keyId}`;
    if (opts.send) this.send = opts.send;
    else {
      const client = new KMSClient(opts.region ? { region: opts.region } : {});
      this.send = (cmd) => client.send(cmd as EncryptCommand);
    }
  }

  async wrap(dataKey: Buffer, context: string): Promise<Buffer> {
    const out = await this.send(new EncryptCommand({ KeyId: this.keyId, Plaintext: dataKey, EncryptionContext: { abcrm: context } }));
    if (!out.CiphertextBlob) throw new Error("KMS encrypt returned no ciphertext");
    return Buffer.from(out.CiphertextBlob);
  }

  async unwrap(wrapped: Buffer, context: string): Promise<Buffer> {
    const out = await this.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: wrapped, EncryptionContext: { abcrm: context } }));
    if (!out.Plaintext) throw new Error("KMS decrypt returned no plaintext");
    return Buffer.from(out.Plaintext);
  }
}

/** Secret-store wrapping is opt-in; KMS remains the default production provider. */
export function keyProviderFromEnv(env = process.env): KeyProvider {
  if (env.ABCRM_KEY_PROVIDER && !["secret", "kms"].includes(env.ABCRM_KEY_PROVIDER)) throw new Error("Unknown ABCRM_KEY_PROVIDER");
  if (env.ABCRM_KEY_PROVIDER === "secret") {
    if (env.ABCRM_KMS_KEY_ID) throw new Error("Remove ABCRM_KMS_KEY_ID before selecting the secret provider");
    return SecretKeyProvider.fromEnv(env);
  }
  if (env.ABCRM_KMS_KEY_ID) return new AwsKmsKeyProvider(env.ABCRM_KMS_KEY_ID, { region: env.AWS_REGION });
  if (env.NODE_ENV === "production" || env.ABCRM_KEY_PROVIDER === "kms") throw new Error("ABCRM_KMS_KEY_ID is required unless ABCRM_KEY_PROVIDER=secret is explicitly configured");
  return LocalKeyProvider.fromEnv(env);
}
