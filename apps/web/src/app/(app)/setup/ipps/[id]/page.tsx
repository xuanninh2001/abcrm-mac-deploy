import { api, me } from "@/lib/api";
import { IppForm, type Ipp } from "@/components/IppForm";

export const dynamic = "force-dynamic";

export default async function IppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [ipp, user] = await Promise.all([api<Ipp>(`/ipps/${id}`), me()]);
  return (
    <>
      <div className="small"><a href="/setup">← Setup</a></div>
      <h1>{ipp.name} <span className="badge">v{ipp.version} · {ipp.status.replace("_", " ")}</span></h1>
      <IppForm ipp={ipp} canEdit={["owner", "admin", "head_of_bd"].includes(user.role)} />
    </>
  );
}
