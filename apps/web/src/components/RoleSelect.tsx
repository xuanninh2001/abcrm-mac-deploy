"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

const ROLES = [["owner", "Owner"], ["admin", "Admin"], ["head_of_bd", "Head of BD"], ["sales_rep", "Sales rep"], ["viewer", "Viewer"]] as const;

/** Changes a teammate's role; the API enforces who may grant or remove owner. */
export function RoleSelect({ userId, role, label, allowOwner }: { userId: string; role: string; label: string; allowOwner: boolean }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="row small">
      <select aria-label={`Role of ${label}`} defaultValue={role} onChange={async (e) => {
        const next = e.target.value;
        if (next === "owner" && !window.confirm(`Make ${label} an owner? Owners can manage billing and other owners.`)) { e.target.value = role; return; }
        try { await call(`/users/${userId}`, { method: "PATCH", body: { role: next } }); setErr(null); router.refresh(); }
        catch (x) { setErr(errorText(x)); e.target.value = role; }
      }}>
        {ROLES.filter(([v]) => allowOwner || v !== "owner" || role === "owner").map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {err && <span className="error" role="alert">{err}</span>}
    </span>
  );
}
