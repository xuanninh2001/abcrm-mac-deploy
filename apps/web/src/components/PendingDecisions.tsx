"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";
import { DeferredQueue, UNDO_MS, type DeferredItem } from "@/lib/deferred";

type Ctx = {
  /** Sends `body` to `path` after the undo window; the card is hidden from lists meanwhile. */
  defer: (cardId: string, label: string, path: string, body: unknown) => void;
  undo: (cardId: string) => boolean;
  pendingIds: ReadonlySet<string>;
};
const PendingContext = createContext<Ctx | null>(null);

export const usePendingDecisions = () => {
  const c = useContext(PendingContext);
  if (!c) throw new Error("usePendingDecisions outside PendingDecisionsProvider");
  return c;
};

/**
 * Lives in the signed-in layout so a decision keeps waiting while the rep moves to the next card.
 * Undo: the toast button or U. Closing the page sends what is waiting right away (keepalive), so nothing is lost.
 */
export function PendingDecisionsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [items, setItems] = useState<DeferredItem[]>([]);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const queue = useRef<DeferredQueue | null>(null);
  if (!queue.current) {
    queue.current = new DeferredQueue({
      delayMs: UNDO_MS,
      onChange: setItems,
      onError: (item, err) => setFailure({ id: item.id, text: `${item.label} failed: ${errorText(err)}` }),
    });
  }
  const q = queue.current;

  const defer = useCallback((cardId: string, label: string, path: string, body: unknown) => {
    setFailure(null);
    q.add(cardId, label, async (keepalive) => { await call(path, { body, keepalive }); if (!keepalive) router.refresh(); });
  }, [q, router]);
  const undo = useCallback((cardId: string) => q.undo(cardId), [q]);

  useEffect(() => {
    const flush = () => q.flush(true);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [q]);

  // Countdown display and the U shortcut while something is waiting.
  const latest = items[items.length - 1];
  useEffect(() => {
    if (!latest) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key.toLowerCase() !== "u" || e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      e.preventDefault();
      if (q.undo(latest.id)) router.push(`/inbox/${latest.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(t); window.removeEventListener("keydown", onKey); };
  }, [latest, q, router]);

  const value = useMemo(() => ({ defer, undo, pendingIds: new Set(items.map((i) => i.id)) }), [defer, undo, items]);
  return (
    <PendingContext.Provider value={value}>
      {children}
      {(latest || failure) && (
        <div className="toast" role="status" aria-live="polite">
          {latest && (
            <span className="row">
              <span>{latest.label}{items.length > 1 ? ` (+${items.length - 1} more)` : ""}</span>
              <button onClick={() => { if (q.undo(latest.id)) router.push(`/inbox/${latest.id}`); }}>
                Undo <span className="kbd">U</span> {Math.max(0, Math.ceil((latest.due - now) / 1000))}s
              </button>
            </span>
          )}
          {!latest && failure && (
            <span className="row error">{failure.text} <a href={`/inbox/${failure.id}`}>Open the card</a>
              <button onClick={() => setFailure(null)} aria-label="Dismiss">×</button></span>
          )}
        </div>
      )}
    </PendingContext.Provider>
  );
}
