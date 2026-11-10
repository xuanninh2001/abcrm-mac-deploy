"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

/** A button that calls the API (via the BFF) and refreshes the page; errors are shown inline. */
export function Action({ path, method = "POST", body = {}, children, className, confirm, onDone }: {
  path: string; method?: string; body?: unknown; children: ReactNode; className?: string; confirm?: string; onDone?: (r: unknown) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="row">
      <button className={className} disabled={busy} onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true); setErr(null);
        try { const r = await call(path, { method, body }); onDone?.(r); router.refresh(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
      }}>{children}</button>
      {err && <span className="error small" role="alert">{err}</span>}
    </span>
  );
}
