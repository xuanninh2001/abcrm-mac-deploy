"use client";

import { useState } from "react";
import { Button } from "./Button";
import { useTask } from "@/lib/useTask";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { call, errorText } from "@/lib/client";
import { formatHours, parseHours, type WorkingHours } from "@/lib/text";

/** The signed-in person's name, timezone and working hours (card SLAs and the 08:00 digest use them). */
export function ProfileForm({ user }: { user: { name: string | null; timezone: string; locale: string; working_hours: WorkingHours } }) {
  const router = useRouter();
  const { busy, runTask } = useTask();
  const [name, setName] = useState(user.name ?? "");
  const [timezone, setTimezone] = useState(user.timezone);
  const [hours, setHours] = useState(formatHours(user.working_hours));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form className="row" style={{ flexWrap: "wrap", alignItems: "end" }} onSubmit={async (e) => {
      e.preventDefault();
      await runTask(async () => {
      const parsed = parseHours(hours);
      if ("error" in parsed) { setMsg({ ok: false, text: parsed.error }); return; }
      try {
        await call("/users/me", { method: "PATCH", body: { name: name.trim() || null, timezone, working_hours: parsed.hours } });
        setMsg({ ok: true, text: "Saved." });
        router.refresh(); toast.success("Changes saved.");
      } catch (err) { setMsg({ ok: false, text: errorText(err) }); }
      });
    }}>
      <label>Name<br /><input disabled={busy} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Timezone<br /><input disabled={busy} value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Ho_Chi_Minh" /></label>
      <label>Working hours<br /><input disabled={busy} value={hours} onChange={(e) => setHours(e.target.value)} size={36} placeholder="mon-fri 08:30-17:30; sat 09:00-12:00" /></label>
      <Button busy={busy} type="submit">Save profile</Button>
      {msg && <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "small" : "error small"}>{msg.text}</span>}
    </form>
  );
}
