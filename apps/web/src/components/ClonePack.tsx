"use client";

import { useState } from "react";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";

export function ClonePack({ pack, templates, disabled }: { pack: string; templates: string[]; disabled: boolean }) {
  const router = useRouter();
  const { busy, runTask } = useTask();
  const [tpl, setTpl] = useState(templates[0] ?? "");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="row">
      <strong style={{ textTransform: "capitalize" }}>{pack}</strong>
      <select disabled={busy || disabled} aria-label={`${pack} template`} value={tpl} onChange={(e) => setTpl(e.target.value)}>{templates.map((t) => <option key={t}>{t}</option>)}</select>
      <Button busy={busy} disabled={disabled || !tpl} onClick={() => runTask(async () => {
        try {
          const r = await call<{ playbook: { id: string } }>(`/vertical-packs/${pack}/clone`, { body: { ipp_template: tpl } });
          router.push(`/setup/playbooks/${r.playbook.id}`);
        } catch (e) { setErr(errorText(e)); }
      })}>Create draft playbook + IPP</Button>
      {err && <span className="error small" role="alert">{err}</span>}
    </div>
  );
}
