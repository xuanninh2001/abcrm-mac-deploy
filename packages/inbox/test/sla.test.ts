import { describe, expect, it } from "vitest";
import { addWorkingMinutes, isWorkingNow, oneWorkingDay, windows } from "../src/sla.js";

const HCM = "Asia/Ho_Chi_Minh";   // UTC+7, no DST
const hours = { "mon-fri": ["08:30", "17:30"] } as Record<string, [string, string]>;

describe("working-hours SLA", () => {
  it("expands day ranges", () => {
    const w = windows(hours);
    expect(w[0]).toBeNull();
    expect(w[1]).toEqual([510, 1050]);
    expect(w[5]).toEqual([510, 1050]);
    expect(w[6]).toBeNull();
    expect(windows({ "fri-mon": ["09:00", "10:00"] }).map(Boolean)).toEqual([true, true, false, false, false, true, true]);
  });

  it("knows when someone is at work", () => {
    expect(isWorkingNow(new Date("2026-10-26T03:00:00Z"), HCM, hours)).toBe(true);    // Mon 10:00 local
    expect(isWorkingNow(new Date("2026-10-26T12:00:00Z"), HCM, hours)).toBe(false);   // Mon 19:00 local
    expect(isWorkingNow(new Date("2026-10-25T03:00:00Z"), HCM, hours)).toBe(false);   // Sunday
  });

  it("adds working minutes across evenings and weekends", () => {
    const day = oneWorkingDay(hours);
    expect(day).toBe(540);
    // Fri 16:30 local + 1 working day → Mon 16:30 local (1h Fri, 8h Mon).
    expect(addWorkingMinutes(new Date("2026-10-30T09:30:00Z"), day, HCM, hours).toISOString()).toBe("2026-11-02T09:30:00.000Z");
    // Sat 10:00 local → starts Mon 08:30 → Mon 17:30.
    expect(addWorkingMinutes(new Date("2026-10-31T03:00:00Z"), day, HCM, hours).toISOString()).toBe("2026-11-02T10:30:00.000Z");
    // Mon 07:00 local → Mon 08:30 + 9h = Mon 17:30.
    expect(addWorkingMinutes(new Date("2026-10-26T00:00:00Z"), day, HCM, hours).toISOString()).toBe("2026-10-26T10:30:00.000Z");
  });

  it("handles DST in US zones", () => {
    // New York DST ends Sun 2026-11-01. Fri 17:00 EDT (21:00Z) + 60 working min = 30 min Fri + 30 min Mon → Mon 09:00 EST (14:00Z).
    const r = addWorkingMinutes(new Date("2026-10-30T21:00:00Z"), 60, "America/New_York", { "mon-fri": ["08:30", "17:30"] });
    expect(r.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});
