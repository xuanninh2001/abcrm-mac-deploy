import type { VerticalPack } from "@abcrm/setup";

export type IppForPlanning = { lead_types: string[]; signals: { text: string[] } };

/** Deterministic query plan from IPP + pack templates (the LLM planner of S1 refines this in Phase 1). */
export function planQueries(ipp: IppForPlanning, pack: VerticalPack, max = 30): string[] {
  const label = (key: string) => pack.taxonomy.lead_types.find((l) => l.key === key)?.label ?? key.replace(/_/g, " ");
  const out: string[] = [];
  for (const lt of ipp.lead_types) {
    for (const tpl of pack.query_templates) {
      out.push(tpl.replaceAll("{lead_type_label}", label(lt)).replaceAll("{lead_type}", lt));
    }
  }
  for (const phrase of ipp.signals.text.slice(0, 5)) out.push(`"${phrase}" ${pack.key}`);
  return [...new Set(out.map((q) => q.replace(/\s+/g, " ").trim()))].slice(0, max);
}
