"use client";
import { useRef, useState } from "react";

/** Acquire the lock before React renders, including rapid repeated clicks. */
export function useTask() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const runTask = async (task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try { await task(); } finally { lock.current = false; setBusy(false); }
  };
  return { busy, runTask };
}
