import { redirect } from "next/navigation";
import { api, me } from "@/lib/api";
import { PageHeading } from "@/components/PageHeading";
import { SourceSettings, type SourcesData } from "@/components/SourceSettings";
export const dynamic = "force-dynamic";
export default async function SourcesPage() {
  if ((await me()).role !== "owner") redirect("/inbox");
  const initial = await api<SourcesData>("/sources");
  return <><PageHeading eyebrow="DATA CONNECTIONS" title="Sources / Nguồn dữ liệu" description="Manage search providers and contact sources for this workspace." /><SourceSettings initial={initial} /></>;
}
