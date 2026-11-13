import { afterEach, expect, it, vi } from "vitest";
import { HunterContactProvider } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
it("keeps only provider-verified personal contacts without phones", async () => {
  const person = { value: "ann@example.com", first_name: "Ann", last_name: "Lee", position: "Affiliate Manager", phone_number: "never-copy" };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { emails: [
    { ...person, verification: { status: "valid" } }, { ...person, verification: { status: "accept_all" } },
    { ...person, verification: { status: "invalid" } }, { ...person },
  ] } })));
  vi.stubGlobal("fetch", fetch);
  const result = await new HunterContactProvider("secret").find("example.com", ["Affiliate Manager"], 2);
  expect(result.people).toHaveLength(1);
  expect(result.people[0]).toMatchObject({ firstName: "Ann", email: "ann@example.com", title: "Affiliate Manager" });
  expect(JSON.stringify(result)).not.toContain("never-copy");
  const url = new URL(fetch.mock.calls[0]![0]);
  expect(url.searchParams.get("type")).toBe("personal");
  expect(url.searchParams.get("domain")).toBe("example.com");
});
it("tests account access without domain search and redacts network errors", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { email: "owner@example.com" } })))
    .mockRejectedValueOnce(new Error("failed at https://api.hunter.io/?api_key=secret"));
  vi.stubGlobal("fetch", fetch);
  const adapter = new HunterContactProvider("secret");
  await adapter.test();
  expect(new URL(fetch.mock.calls[0]![0]).pathname).toBe("/v2/account");
  await expect(adapter.test()).rejects.toThrow("Hunter connection failed or timed out.");
});
