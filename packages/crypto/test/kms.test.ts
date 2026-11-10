import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { AwsKmsKeyProvider, generateKey, keyProviderFromEnv, LocalKeyProvider, type KmsSend } from "../src/index.js";

/** In-memory stand-in for KMS that enforces EncryptionContext like the real service. */
function fakeKms(): { send: KmsSend; calls: string[] } {
  const master = randomBytes(32);
  const calls: string[] = [];
  const send: KmsSend = async (cmd) => {
    const ctx = JSON.stringify(cmd.input.EncryptionContext ?? {});
    if (cmd instanceof EncryptCommand) {
      calls.push(`encrypt:${cmd.input.KeyId}`);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", master, iv);
      c.setAAD(Buffer.from(ctx));
      const ct = Buffer.concat([c.update(cmd.input.Plaintext as Uint8Array), c.final()]);
      return { CiphertextBlob: Buffer.concat([iv, c.getAuthTag(), ct]) };
    }
    calls.push(`decrypt:${cmd.input.KeyId}`);
    const blob = Buffer.from(cmd.input.CiphertextBlob as Uint8Array);
    const d = createDecipheriv("aes-256-gcm", master, blob.subarray(0, 12));
    d.setAAD(Buffer.from(ctx));
    d.setAuthTag(blob.subarray(12, 28));
    return { Plaintext: Buffer.concat([d.update(blob.subarray(28)), d.final()]) };
  };
  return { send, calls };
}

describe("AwsKmsKeyProvider", () => {
  it("wraps/unwraps through KMS with the tenant context as EncryptionContext", async () => {
    const kms = fakeKms();
    const kp = new AwsKmsKeyProvider("alias/abcrm-us", { send: kms.send });
    const dek = generateKey();
    const wrapped = await kp.wrap(dek, "tenant:A:dek");
    expect((await kp.unwrap(wrapped, "tenant:A:dek")).equals(dek)).toBe(true);
    await expect(kp.unwrap(wrapped, "tenant:B:dek")).rejects.toThrow();
    expect(kms.calls[0]).toBe("encrypt:alias/abcrm-us");
    expect(kp.keyRef).toBe("aws-kms:alias/abcrm-us");
  });

  it("passes the expected command shapes", async () => {
    const seen: (EncryptCommand | DecryptCommand)[] = [];
    const kp = new AwsKmsKeyProvider("k1", { send: async (cmd) => { seen.push(cmd); return { CiphertextBlob: new Uint8Array([1]), Plaintext: new Uint8Array(32) }; } });
    await kp.wrap(generateKey(), "tenant:T:bidx");
    await kp.unwrap(Buffer.from([1]), "tenant:T:bidx");
    expect(seen[0]!.input).toMatchObject({ KeyId: "k1", EncryptionContext: { abcrm: "tenant:T:bidx" } });
    expect(seen[1]).toBeInstanceOf(DecryptCommand);
  });
});

describe("keyProviderFromEnv", () => {
  it("requires KMS in production", () => {
    expect(() => keyProviderFromEnv({ NODE_ENV: "production" })).toThrow(/ABCRM_KMS_KEY_ID/);
    expect(keyProviderFromEnv({ NODE_ENV: "production", ABCRM_KMS_KEY_ID: "k", AWS_REGION: "us-east-1" })).toBeInstanceOf(AwsKmsKeyProvider);
  });
  it("falls back to the local provider in development", () => {
    expect(keyProviderFromEnv({ NODE_ENV: "development" })).toBeInstanceOf(LocalKeyProvider);
  });
});
