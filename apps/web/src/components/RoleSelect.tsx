"use client";

import { useEffect, useState } from "react";
import { useConfirm } from "./FeedbackProvider";
import { useTask } from "@/lib/useTask";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

const ROLES = [["owner", "Owner"], ["admin", "Admin"], ["head_of_bd", "Head of BD"], ["sales_rep", "Sales rep"], ["viewer", "Viewer"]] as const;

/** Changes a teammate's role; the API enforces who may grant or remove owner. */
export function RoleSelect({ userId, role, label, allowOwner }: { userId: string; role: string; label: string; allowOwner: boolean }) {
  const router = useRouter();
  const ask = useConfirm();
  const { busy, runTask } = useTask();
  const [selected, setSelected] = useState(role);
  useEffect(() => setSelected(role), [role]);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="row small">
      <select aria-label={`Role of ${label}`} value={selected} disabled={busy} aria-busy={busy} onChange={(e) => {
        const next = e.target.value;
        void runTask(async () => {
        if (next === "owner" && !await ask(`Make ${label} an owner? Owners can manage billing and other owners.`)) { return; }
        try { await call(`/users/${userId}`, { method: "PATCH", body: { role: next } }); setSelected(next); setErr(null); router.refresh(); toast.success("Role updated."); }
        catch (x) { setErr(errorText(x)); }
        });
      }}>
        {ROLES.filter(([v]) => allowOwner || v !== "owner" || role === "owner").map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {err && <span className="error" role="alert">{err}</span>}
    </span>
  );
}
