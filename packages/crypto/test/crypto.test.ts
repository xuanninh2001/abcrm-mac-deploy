import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { blindIndex, decryptField, encryptField, generateKey, LocalKeyProvider, normalizeDomain, normalizeEmail, normalizeText } from "../src/index.js";

describe("field encryption", () => {
  it("round-trips arbitrary strings", () => {
    const key = generateKey();
    fc.assert(fc.property(fc.string(), (s) => decryptField(key, encryptField(key, s, "t:col"), "t:col") === s));
  });

  it("fails when AAD (tenant/column binding) differs", () => {
    const key = generateKey();
    const blob = encryptField(key, "jane@acme.com", "tenantA:contacts.email");
    expect(() => decryptField(key, blob, "tenantB:contacts.email")).toThrow();
  });

  it("fails with another key and on tampering", () => {
    const blob = encryptField(generateKey(), "x", "a");
    expect(() => decryptField(generateKey(), blob, "a")).toThrow();
    const key = generateKey();
    const ok = encryptField(key, "hello", "a");
    ok[ok.length - 1]! ^= 1;
    expect(() => decryptField(key, ok, "a")).toThrow();
  });

  it("uses a fresh IV per encryption", () => {
    const key = generateKey();
    expect(encryptField(key, "same", "a").equals(encryptField(key, "same", "a"))).toBe(false);
  });
});

describe("blind index", () => {
  it("is deterministic per key+purpose and differs across keys/purposes", () => {
    const k1 = generateKey(), k2 = generateKey();
    expect(blindIndex(k1, "email", "a@b.co").equals(blindIndex(k1, "email", "a@b.co"))).toBe(true);
    expect(blindIndex(k1, "email", "a@b.co").equals(blindIndex(k2, "email", "a@b.co"))).toBe(false);
    expect(blindIndex(k1, "email", "a@b.co").equals(blindIndex(k1, "domain", "a@b.co"))).toBe(false);
  });
});

describe("normalizers", () => {
  it("normalizes emails and domains", () => {
    expect(normalizeEmail("  Jane.Doe@Acme.COM ")).toBe("jane.doe@acme.com");
    expect(normalizeDomain("https://www.Acme-Health.co.uk/partners?x=1")).toBe("acme-health.co.uk");
    expect(normalizeDomain("jane@leads.acme.com")).toBe("acme.com");
    expect(() => normalizeDomain("not a domain")).toThrow();
  });

  it("normalizes text for quote matching", () => {
    expect(normalizeText("We  buy\n“Medicare” leads — from publishers")).toBe('we buy "medicare" leads - from publishers');
  });
});

describe("LocalKeyProvider", () => {
  it("wraps and unwraps with context binding", async () => {
    const kp = new LocalKeyProvider(generateKey());
    const dek = generateKey();
    const wrapped = await kp.wrap(dek, "tenant:1:dek");
    expect((await kp.unwrap(wrapped, "tenant:1:dek")).equals(dek)).toBe(true);
    await expect(kp.unwrap(wrapped, "tenant:2:dek")).rejects.toThrow();
  });

  it("refuses to run in production", () => {
    expect(() => LocalKeyProvider.fromEnv({ NODE_ENV: "production" })).toThrow();
  });
});
