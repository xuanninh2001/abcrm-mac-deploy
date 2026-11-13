import { redirect } from "next/navigation";
import { api, me } from "@/lib/api";
import { PageHeading } from "@/components/PageHeading";
import { LlmSettings, type LlmConfig } from "@/components/LlmSettings";

export const dynamic = "force-dynamic";
export default async function LlmPage() {
  const user = await me();
  if (user.role !== "owner") redirect("/inbox");
  const initial = await api<LlmConfig>("/llm-settings");
  return <><PageHeading eyebrow="AI CONFIGURATION" title="AI / LLM" description="Connect your 9router tunnel, select a model and verify structured AI responses." /><LlmSettings initial={initial} /></>;
}
