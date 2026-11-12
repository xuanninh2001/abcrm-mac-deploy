"use client";

import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "./Button";
import { useConfirm } from "./FeedbackProvider";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

/** A button that calls the API (via the BFF) and refreshes the page; errors are shown inline. */
export function Action({ path, method = "POST", body = {}, children, className, confirm, onDone }: {
  path: string; method?: string; body?: unknown; children: ReactNode; className?: string; confirm?: string; onDone?: (r: unknown) => void;
}) {
  const router = useRouter();
  const ask = useConfirm();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="row">
      <Button className={className} busy={busy} onClick={async () => {
        if (lock.current) return;
        lock.current = true;
        if (confirm && !await ask(confirm)) { lock.current = false; return; }
        setBusy(true); setErr(null);
        try { const r = await call(path, { method, body }); onDone?.(r); router.refresh(); toast.success("Action completed."); } catch (e) { setErr(errorText(e)); toast.error("Action failed. See details beside the button."); } finally { setBusy(false); lock.current = false; }
      }}>{children}</Button>
      {err && <span className="error small" role="alert">{err}</span>}
    </span>
  );
}
