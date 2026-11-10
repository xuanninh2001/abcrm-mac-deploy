import Link from "next/link";
import { api } from "@/lib/api";
import { ImportJob, type Job, type Row } from "@/components/ImportJob";

export const dynamic = "force-dynamic";

export default async function ImportDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await api<Job>(`/imports/${id}`);
  const problems = job.stats.dry_run
    ? await Promise.all([api<{ data: Row[] }>(`/imports/${id}/rows?status=error&limit=50`), api<{ data: Row[] }>(`/imports/${id}/rows?status=warning&limit=50`)])
    : null;
  return (
    <>
      <p className="small"><Link href="/imports">← Imports</Link></p>
      <ImportJob job={job} errors={problems?.[0].data ?? []} warnings={problems?.[1].data ?? []} />
    </>
  );
}
