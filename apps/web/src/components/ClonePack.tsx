"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

export function ClonePack({ pack, templates, disabled }: { pack: string; templates: string[]; disabled: boolean }) {
  const router = useRouter();
  const [tpl, setTpl] = useState(templates[0] ?? "");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="row">
      <strong style={{ textTransform: "capitalize" }}>{pack}</strong>
      <select aria-label={`${pack} template`} value={tpl} onChange={(e) => setTpl(e.target.value)}>{templates.map((t) => <option key={t}>{t}</option>)}</select>
      <button disabled={disabled || !tpl} onClick={async () => {
        try {
          const r = await call<{ playbook: { id: string } }>(`/vertical-packs/${pack}/clone`, { body: { ipp_template: tpl } });
          router.push(`/setup/playbooks/${r.playbook.id}`);
        } catch (e) { setErr(errorText(e)); }
      }}>Create draft playbook + IPP</button>
      {err && <span className="error small">{err}</span>}
    </div>
  );
}
