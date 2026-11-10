import { describe, expect, it } from "vitest";
import { aiSegments, cardKey, fieldLabel, formatHours, mappingComplete, nextMorning, parseHours, parseSummary } from "../src/lib/text";
import { safeNext } from "../src/lib/paths";
import { jwtExp, seal, unseal } from "../src/lib/seal";

describe("aiSegments", () => {
  it("marks AI spans and keeps the rest verbatim", () => {
    const body = "Hi Ann,\n\nYou buy ACA leads. We supply them.\n\nOpen to a test?";
    const s = aiSegments(body, [{ start: 9, end: 27 }, { start: 100, end: 120 }, { start: 5, end: 3 }]);
    expect(s.map((x) => x.text).join("")).toBe(body);
    expect(s.filter((x) => x.ai).map((x) => x.text)).toEqual(["You buy ACA leads."]);
  });
  it("handles overlapping spans", () => {
    const s = aiSegments("abcdefgh", [{ start: 0, end: 4 }, { start: 2, end: 6 }]);
    expect(s).toEqual([{ text: "abcd", ai: true }, { text: "ef", ai: true }, { text: "gh", ai: false }]);
  });
});

describe("cardKey", () => {
  it.each([
    [{ key: "a", shiftKey: false }, "approve"], [{ key: "A", shiftKey: true }, "approve_no_email"], [{ key: "r", shiftKey: false }, "reject"],
    [{ key: "s", shiftKey: false }, "snooze"], [{ key: "j", shiftKey: false }, "next"], [{ key: "k", shiftKey: false }, "prev"],
    [{ key: "e", shiftKey: false }, "edit"], [{ key: "Escape", shiftKey: false }, "escape"], [{ key: "x", shiftKey: false }, null],
    [{ key: "a", shiftKey: false, targetTag: "TEXTAREA" }, null], [{ key: "a", shiftKey: false, metaKey: true }, null],
  ])("%j → %s", (e, action) => expect(cardKey(e)).toBe(action));
});

describe("helpers", () => {
  it("snoozes to the next 09:00 at least an hour away", () => {
    const at = (h: number) => { const d = new Date(2026, 9, 26, h, 30); return nextMorning(d); };
    expect(at(7).getDate()).toBe(26);
    expect(at(8).getDate()).toBe(27);
    expect(at(15).getHours()).toBe(9);
  });
  it("only allows same-origin redirect targets", () => {
    expect(safeNext("/inbox/123")).toBe("/inbox/123");
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "", null]) expect(safeNext(bad)).toBe("/inbox");
  });
  it("seals sessions and rejects tampering", () => {
    const k = Buffer.alloc(32, 3);
    const s = seal(k, { kind: "dev", token: "dev:a:b" });
    expect(unseal(k, s)).toEqual({ kind: "dev", token: "dev:a:b" });
    expect(unseal(Buffer.alloc(32, 4), s)).toBeNull();
    expect(unseal(k, s.slice(0, -2) + "AA")).toBeNull();
    const jwt = ["e30", Buffer.from(JSON.stringify({ exp: 123 })).toString("base64url"), "sig"].join(".");
    expect(jwtExp(jwt)).toBe(123);
    expect(jwtExp("garbage")).toBeNull();
  });
});

describe("parseSummary", () => {
  it("splits why-fit and risks", () => {
    expect(parseSummary("Why fit:\n- Buys ACA\n- Uses TrustedForm\nRisks:\n- Offshore unclear")).toEqual({ why: ["Buys ACA", "Uses TrustedForm"], risks: ["Offshore unclear"] });
    expect(parseSummary(null)).toEqual({ why: [], risks: [] });
  });
});

describe("working hours text", () => {
  it("round-trips and normalizes", () => {
    const h = { "mon-fri": ["08:30", "17:30"], sat: ["09:00", "12:00"] } as Record<string, [string, string]>;
    expect(formatHours(h)).toBe("mon-fri 08:30-17:30; sat 09:00-12:00");
    expect(parseHours("Mon-Fri 8:30 - 17:30; sat 09:00-12:00")).toEqual({ hours: h });
  });
  it("explains bad input", () => {
    expect(parseHours("weekdays 9-5")).toMatchObject({ error: expect.stringContaining("weekdays 9-5") });
    expect(parseHours("  ")).toEqual({ error: "Add at least one day range." });
  });
});

describe("import mapping", () => {
  it("needs one complete alternative group", () => {
    const req = [["email"], ["company_domain", "first_name"]];
    expect(mappingComplete(req, ["company_domain"])).toBe(false);
    expect(mappingComplete(req, ["company_domain", "first_name", "title"])).toBe(true);
    expect(mappingComplete(req, ["email"])).toBe(true);
    expect(fieldLabel("company_domain")).toBe("Company domain");
  });
});
