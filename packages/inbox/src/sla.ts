/** Working hours as stored on users.working_hours, e.g. {"mon-fri": ["08:30", "17:30"], "sat": ["09:00", "12:00"]}. */
export type WorkingHours = Record<string, [string, string]>;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_HOURS: WorkingHours = { "mon-fri": ["08:30", "17:30"] };

/** Expands "mon-fri" style keys into a per-weekday [startMin, endMin] window. */
export function windows(hours: WorkingHours | null | undefined): ([number, number] | null)[] {
  const out: ([number, number] | null)[] = Array(7).fill(null);
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  for (const [key, range] of Object.entries(hours && Object.keys(hours).length ? hours : DEFAULT_HOURS)) {
    const [a, b] = key.toLowerCase().split("-");
    const from = DAYS.indexOf(a!);
    const to = b ? DAYS.indexOf(b) : from;
    if (from < 0 || to < 0 || !Array.isArray(range)) continue;
    const w: [number, number] = [toMin(range[0]), toMin(range[1])];
    if (w[1] <= w[0]) continue;
    for (let d = from; ; d = (d + 1) % 7) { out[d] = w; if (d === to) break; }
  }
  return out;
}

/** Local wall-clock parts of an instant in an IANA zone. */
function local(at: Date, tz: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: DAYS.indexOf(get("weekday").toLowerCase().slice(0, 3)), minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isWorkingNow(at: Date, tz: string, hours: WorkingHours | null | undefined): boolean {
  const w = windows(hours);
  const l = local(at, tz);
  const today = w[l.day];
  return !!today && l.minute >= today[0] && l.minute < today[1];
}

/**
 * Adds `minutes` of working time in the assignee's zone and hours (decision-inbox.md §3: SLA in working hours).
 * Walks minute-blocks between windows; robust to DST because each step re-reads the local clock.
 */
export function addWorkingMinutes(start: Date, minutes: number, tz: string, hours: WorkingHours | null | undefined): Date {
  const w = windows(hours);
  if (!w.some(Boolean)) return new Date(start.getTime() + minutes * 60_000);
  let t = new Date(start.getTime());
  let left = minutes;
  for (let guard = 0; guard < 24 * 60 && left > 0; guard++) {
    const l = local(t, tz);
    const today = w[l.day];
    if (today && l.minute >= today[0] && l.minute < today[1]) {
      const step = Math.min(left, today[1] - l.minute);
      t = new Date(t.getTime() + step * 60_000);
      left -= step;
    } else {
      // Jump to the next window start (today later, or a following day).
      let jump: number | null = null;
      if (today && l.minute < today[0]) jump = today[0] - l.minute;
      else {
        for (let d = 1; d <= 7 && jump === null; d++) {
          const next = w[(l.day + d) % 7];
          if (next) jump = (24 * 60 - l.minute) + (d - 1) * 24 * 60 + next[0];
        }
      }
      t = new Date(t.getTime() + (jump ?? 60) * 60_000);
    }
  }
  return t;
}

/** One working day = the length of the assignee's longest daily window (lane `contact`). */
export function oneWorkingDay(hours: WorkingHours | null | undefined): number {
  return Math.max(60, ...windows(hours).map((w) => (w ? w[1] - w[0] : 0)));
}
