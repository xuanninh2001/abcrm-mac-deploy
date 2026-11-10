/** How long an approve/reject waits before it is sent, so it can be undone (decision-inbox: undo). */
export const UNDO_MS = 5000;

export type DeferredItem = { id: string; label: string; due: number };
type Entry = DeferredItem & { run: (keepalive: boolean) => Promise<void>; timer: ReturnType<typeof setTimeout> };

/**
 * Holds decisions for `delayMs` before sending them. Undo drops one; flush sends everything at once
 * (used when the page is closing, with keepalive requests). One entry per id: a newer one replaces it.
 */
export class DeferredQueue {
  private entries = new Map<string, Entry>();

  constructor(private readonly opts: {
    delayMs: number; onChange: (items: DeferredItem[]) => void; onError: (item: DeferredItem, err: unknown) => void; now?: () => number;
  }) {}

  add(id: string, label: string, run: (keepalive: boolean) => Promise<void>): void {
    this.drop(id);
    const due = (this.opts.now ?? Date.now)() + this.opts.delayMs;
    const timer = setTimeout(() => void this.send(id, false), this.opts.delayMs);
    this.entries.set(id, { id, label, due, run, timer });
    this.changed();
  }

  /** Returns true when the item was still waiting (and is now cancelled). */
  undo(id: string): boolean {
    const had = this.drop(id);
    if (had) this.changed();
    return had;
  }

  flush(keepalive = true): void {
    for (const id of [...this.entries.keys()]) void this.send(id, keepalive);
  }

  items(): DeferredItem[] {
    return [...this.entries.values()].map(({ id, label, due }) => ({ id, label, due }));
  }

  private async send(id: string, keepalive: boolean) {
    const e = this.entries.get(id);
    if (!e) return;
    this.drop(id);
    this.changed();
    try { await e.run(keepalive); } catch (err) { this.opts.onError({ id: e.id, label: e.label, due: e.due }, err); }
  }

  private drop(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    clearTimeout(e.timer);
    this.entries.delete(id);
    return true;
  }

  private changed() { this.opts.onChange(this.items()); }
}
