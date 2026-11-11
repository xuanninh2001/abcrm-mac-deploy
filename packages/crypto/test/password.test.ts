import { expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.js";
it("salts passwords and verifies only the correct password",async()=>{
  const password="a sufficiently long password";
  const a=await hashPassword(password), b=await hashPassword(password);
  expect(a).not.toBe(b);expect(a).not.toContain(password);
  expect(await verifyPassword(password,a)).toBe(true);
  expect(await verifyPassword("wrong password",a)).toBe(false);
  expect(await verifyPassword(password,"invalid")).toBe(false);
});
it("rejects short and oversized UTF-8 passwords",async()=>{
  await expect(hashPassword("short")).rejects.toThrow();
  await expect(hashPassword("\u3042".repeat(90))).rejects.toThrow();
  expect(await verifyPassword("x".repeat(257),"invalid")).toBe(false);
});
