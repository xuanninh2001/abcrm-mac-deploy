import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredQueue } from "../src/lib/deferred";

describe("DeferredQueue (undo window)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = () => {
    const sent: string[] = [];
    const errors: string[] = [];
    const q = new DeferredQueue({ delayMs: 5000, onChange: () => {}, onError: (i) => errors.push(i.id) });
    const run = (id: string, fail = false) => async (keepalive: boolean) => { if (fail) throw new Error("x"); sent.push(`${id}${keepalive ? ":keepalive" : ""}`); };
    return { q, sent, errors, run };
  };

  it("sends after the delay, not before", async () => {
    const { q, sent, run } = setup();
    q.add("c1", "Approved a", run("c1"));
    await vi.advanceTimersByTimeAsync(4999);
    expect(sent).toEqual([]);
    expect(q.items().map((i) => i.id)).toEqual(["c1"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["c1"]);
    expect(q.items()).toEqual([]);
  });

  it("undo cancels; undo after sending does nothing", async () => {
    const { q, sent, run } = setup();
    q.add("c1", "a", run("c1"));
    expect(q.undo("c1")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
    q.add("c2", "b", run("c2"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(q.undo("c2")).toBe(false);
    expect(sent).toEqual(["c2"]);
  });

  it("a newer decision on the same card replaces the waiting one", async () => {
    const { q, sent, run } = setup();
    q.add("c1", "approve", run("approve"));
    q.add("c1", "reject", run("reject"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual(["reject"]);
  });

  it("flush sends everything now with keepalive; failures are reported", async () => {
    const { q, sent, errors, run } = setup();
    q.add("c1", "a", run("c1"));
    q.add("c2", "b", run("c2", true));
    q.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["c1:keepalive"]);
    expect(errors).toEqual(["c2"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual(["c1:keepalive"]);
  });
});
