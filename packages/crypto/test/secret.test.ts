import { describe, expect, it } from "vitest";
import { generateKey, keyProviderFromEnv, SecretKeyProvider } from "../src/index.js";

describe("secret-store key provider", () => {
  it("unwraps across service restarts with the same secret and binds tenant context", async () => {
    const env = { NODE_ENV: "production", ABCRM_KEY_PROVIDER: "secret", ABCRM_MASTER_KEY: generateKey().toString("base64") };
    const api = keyProviderFromEnv(env), worker = keyProviderFromEnv(env);
    expect(api).toBeInstanceOf(SecretKeyProvider);
    expect(api.keyRef).toBe("secret:v1");
    const key = generateKey();
    const wrapped = await api.wrap(key, "tenant:1:dek");
    expect(await worker.unwrap(wrapped, "tenant:1:dek")).toEqual(key);
    expect(await api.wrap(key, "tenant:1:dek")).not.toEqual(wrapped);
    await expect(worker.unwrap(wrapped, "tenant:2:dek")).rejects.toThrow();
    await expect(new SecretKeyProvider(generateKey()).unwrap(wrapped, "tenant:1:dek")).rejects.toThrow();
    wrapped[wrapped.length - 1]! ^= 1;
    await expect(worker.unwrap(wrapped, "tenant:1:dek")).rejects.toThrow();
  });

  it("fails closed for missing, malformed, or conflicting configuration", () => {
    for (const value of [undefined, "", "invalid", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), generateKey().toString("base64") + "!"]) {
      expect(() => keyProviderFromEnv({ NODE_ENV: "production", ABCRM_KEY_PROVIDER: "secret", ABCRM_MASTER_KEY: value })).toThrow(/ABCRM_MASTER_KEY/);
    }
    expect(() => keyProviderFromEnv({ NODE_ENV: "production", ABCRM_MASTER_KEY: generateKey().toString("base64") })).toThrow();
    expect(() => keyProviderFromEnv({ ABCRM_KEY_PROVIDER: "typo" })).toThrow();
    expect(() => keyProviderFromEnv({ ABCRM_KEY_PROVIDER: "kms" })).toThrow();
    expect(() => keyProviderFromEnv({ ABCRM_KEY_PROVIDER: "secret", ABCRM_KMS_KEY_ID: "existing" })).toThrow();
  });
});
