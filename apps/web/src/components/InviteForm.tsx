"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

const REASONS: Record<string, string> = {
  local_account_created: "Internal account is ready. Share the password securely; the user can change it after signing in.",
  local_password_required: "Ask the server administrator to set a password before signing in.",
  tenant_has_no_workos_organization: "This workspace is not linked to a WorkOS organization yet, so no email was sent.",
};

type Result = { user: { email: string }; invitation: { sent: boolean; reason?: string } };

export function InviteForm({ canInviteOwner }: { canInviteOwner: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("sales_rep");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="row" style={{ flexWrap: "wrap" }} onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setMsg(null);
      try {
        const r = await call<Result>("/users", { body: { email, role, password, ...(name.trim() ? { name: name.trim() } : {}) } });
        setMsg({ ok: true, text: r.invitation.sent ? `Invitation sent to ${r.user.email}.` : `${r.user.email} added. ${REASONS[r.invitation.reason ?? ""] ?? ""}` });
        setEmail(""); setName(""); setPassword("");
        router.refresh();
      } catch (err) { setMsg({ ok: false, text: errorText(err) }); } finally { setBusy(false); }
    }}>
      <label>Email <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" /></label>
      <label>Initial password <input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <label>Role <select value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="sales_rep">Sales rep</option><option value="head_of_bd">Head of BD</option>
        <option value="viewer">Viewer</option><option value="admin">Admin</option>
        {canInviteOwner && <option value="owner">Owner</option>}
      </select></label>
      <button className="primary" disabled={busy} type="submit">Create account</button>
      {msg && <span role="status" className={msg.ok ? "small" : "error small"}>{msg.text}</span>}
    </form>
  );
}
