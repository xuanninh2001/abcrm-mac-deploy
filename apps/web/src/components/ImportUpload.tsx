"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorText, upload } from "@/lib/client";

const PURPOSES = [
  ["accounts", "Accounts", "Companies (buyers or prospects) with their domain."],
  ["contacts", "Contacts", "People with an email, or a company domain plus their name."],
  ["existing_buyers", "Existing buyers", "Buyers you already work with; sourcing will not card them again."],
  ["blocklist", "Do-not-contact list", "Emails or domains that must never be contacted."],
] as const;

/** Step 1: upload a CSV/XLSX; the API stages the rows and proposes a column mapping. */
export function ImportUpload() {
  const router = useRouter();
  const [purpose, setPurpose] = useState<string>("accounts");
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { setErr("The file is larger than 20 MB. Split it and import the parts."); return; }
      const form = new FormData();
      form.set("file", file);
      form.set("purpose", purpose);
      if (sheet.trim()) form.set("sheet", sheet.trim());
      setBusy(true); setErr(null);
      try {
        const r = await upload<{ jobId: string }>("/imports", form);
        router.push(`/imports/${r.jobId}`);
      } catch (x) { setErr(errorText(x)); setBusy(false); }
    }}>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend className="small muted">What does the file contain?</legend>
        {PURPOSES.map(([v, l, d]) => (
          <label key={v} className="row" style={{ padding: "2px 0" }}>
            <input type="radio" name="purpose" value={v} checked={purpose === v} onChange={() => setPurpose(v)} />
            <strong>{l}</strong> <span className="muted small">{d}</span>
          </label>
        ))}
      </fieldset>
      <p className="row" style={{ flexWrap: "wrap" }}>
        <label>File (CSV or XLSX, up to 20 MB)<br />
          <input type="file" required accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label>Sheet (XLSX only)<br /><input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="first sheet" /></label>
      </p>
      <div className="row">
        <button className="primary" type="submit" disabled={!file || busy}>{busy ? "Reading file…" : "Upload and map columns"}</button>
        {err && <span className="error small" role="alert">{err}</span>}
      </div>
    </form>
  );
}
