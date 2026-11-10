import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Actor, TenantTx } from "@abcrm/db";
import { Problem } from "@abcrm/core";
import { CriterionInput, PlaybookInput, savePlaybookDraft } from "./playbook.js";
import { IppInput, saveIppDraft, VERTICALS } from "./ipp.js";

const PACKS_DIR = fileURLToPath(new URL("../packs", import.meta.url));

type CriterionDef = Omit<CriterionInput, "key" | "kind" | "weight"> & Partial<Pick<CriterionInput, "kind" | "weight">>;
type TemplateEntry = { key: string; kind: CriterionInput["kind"]; evaluation?: string; weight?: number };
type PlaybookTemplate = {
  tier_thresholds?: PlaybookInput["tier_thresholds"]; card_min_tier?: PlaybookInput["card_min_tier"];
  criteria?: TemplateEntry[]; extends?: string; overrides?: Record<string, Partial<CriterionDef>>;
};

export type VerticalPack = {
  key: string;
  version: number;
  taxonomy: { lead_types: { key: string; label: string }[]; buyer_types: string[] };
  signals: { web_paths: string[]; tech: string[]; text_positive: string[]; text_negative: string[] };
  contact_titles: { primary: string[]; secondary: string[]; synonyms: Record<string, string[]> };
  query_templates: string[];
  ipp_templates: { name: string; lead_types: string[]; buyer_types: string[]; purchase_formats: string[]; payout_models: string[]; playbook: string; contact_titles_from?: "primary" | "secondary" }[];
  criteria_library: Record<string, CriterionDef>;
  playbook_templates: Record<string, PlaybookTemplate>;
  messaging?: unknown;
};

const cache = new Map<string, VerticalPack>();

export async function listPacks(): Promise<string[]> {
  return (await readdir(PACKS_DIR)).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")).sort();
}

export async function loadPack(key: string): Promise<VerticalPack> {
  if (!/^[a-z_]+$/.test(key)) throw new Problem("not-found", "Vertical pack not found");
  const hit = cache.get(key);
  if (hit) return hit;
  let text: string;
  try { text = await readFile(`${PACKS_DIR}/${key}.yaml`, "utf8"); } catch { throw new Problem("not-found", "Vertical pack not found"); }
  const pack = parse(text) as VerticalPack;
  cache.set(key, pack);
  return pack;
}

/** Resolves a playbook template (with `extends`/`overrides`) into a validated PlaybookInput. */
export function expandPlaybookTemplate(pack: VerticalPack, templateKey: string, name: string): PlaybookInput {
  const chain: PlaybookTemplate[] = [];
  for (let k: string | undefined = templateKey; k; k = pack.playbook_templates[k]?.extends) {
    const t = pack.playbook_templates[k];
    if (!t) throw new Problem("not-found", `Playbook template not found: ${k}`);
    if (chain.length > 5) throw new Error("playbook template extends chain too deep");
    chain.unshift(t);
  }
  const base = chain.find((t) => t.criteria) ?? {};
  const overrides = Object.assign({}, ...chain.map((t) => t.overrides ?? {})) as Record<string, Partial<CriterionDef>>;
  const criteria = (base.criteria ?? []).map((entry) => {
    const lib = pack.criteria_library[entry.key];
    if (!lib) throw new Error(`pack ${pack.key}: criterion ${entry.key} missing from criteria_library`);
    return { ...lib, key: entry.key, kind: entry.kind, weight: entry.weight ?? 0, ...overrides[entry.key] };
  });
  return PlaybookInput.parse({
    name, vertical_pack: `${pack.key}@${pack.version}`,
    tier_thresholds: chain.findLast((t) => t.tier_thresholds)?.tier_thresholds,
    card_min_tier: chain.findLast((t) => t.card_min_tier)?.card_min_tier,
    criteria,
  });
}

const ippFromTemplate = (pack: VerticalPack, tpl: VerticalPack["ipp_templates"][number], playbookId: string) => IppInput.parse({
  name: tpl.name, vertical: pack.key, lead_types: tpl.lead_types, buyer_types: tpl.buyer_types,
  purchase_formats: tpl.purchase_formats, payout_models: tpl.payout_models,
  signals: { web_paths: pack.signals.web_paths, tech: pack.signals.tech, text: pack.signals.text_positive },
  exclusions: { keywords: pack.signals.text_negative },
  contact_titles: pack.contact_titles[tpl.contact_titles_from ?? "primary"],
  playbook_id: playbookId,
});

type Messaging = { angles?: string[]; avoid?: string[]; cta_options?: string[] };

/**
 * Structural checks a pack must pass before it ships (CI runs this for every pack): every IPP and playbook
 * template expands into valid input, lead types come from the taxonomy, W1 has angles, an avoid list and CTAs.
 * Returns the problems found (empty = ok).
 */
export function lintPack(pack: VerticalPack): string[] {
  const out: string[] = [];
  const at = (where: string, e: unknown) => out.push(`${where}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  if (!(VERTICALS as readonly string[]).includes(pack.key)) out.push(`key ${pack.key} is not a known vertical`);
  const leadTypes = new Set(pack.taxonomy.lead_types.map((l) => l.key));
  for (const key of Object.keys(pack.playbook_templates)) {
    try { expandPlaybookTemplate(pack, key, key); } catch (e) { at(`playbook_templates.${key}`, e); }
  }
  for (const tpl of pack.ipp_templates) {
    for (const lt of tpl.lead_types) if (!leadTypes.has(lt)) out.push(`ipp_templates "${tpl.name}": lead type ${lt} is not in the taxonomy`);
    if (!pack.playbook_templates[tpl.playbook]) out.push(`ipp_templates "${tpl.name}": playbook ${tpl.playbook} is missing`);
    try { ippFromTemplate(pack, tpl, "00000000-0000-4000-8000-000000000000"); } catch (e) { at(`ipp_templates "${tpl.name}"`, e); }
  }
  if (new Set(pack.ipp_templates.map((t) => t.name)).size !== pack.ipp_templates.length) out.push("ipp template names must be unique");
  for (const q of pack.query_templates) if (!q.includes("{lead_type_label}") && !q.includes("{lead_type}")) out.push(`query template has no lead type placeholder: ${q}`);
  const m = (pack.messaging ?? {}) as Messaging;
  if (!m.angles?.length) out.push("messaging.angles is empty");
  if (!m.avoid?.length) out.push("messaging.avoid is empty");
  if (!m.cta_options?.length || m.cta_options.some((c) => !c.trim().endsWith("?"))) out.push("messaging.cta_options must be questions");
  if (!pack.contact_titles.primary.length) out.push("contact_titles.primary is empty");
  return out;
}

/** Clones an IPP template (and its playbook) from a pack into tenant drafts. */
export async function cloneFromPack(tx: TenantTx, actor: Actor, packKey: string, ippTemplateName: string) {
  const pack = await loadPack(packKey);
  const tpl = pack.ipp_templates.find((t) => t.name === ippTemplateName);
  if (!tpl) throw new Problem("not-found", `IPP template not found: ${ippTemplateName}`);
  const playbook = await savePlaybookDraft(tx, actor, expandPlaybookTemplate(pack, tpl.playbook, tpl.name));
  const ipp = await saveIppDraft(tx, actor, ippFromTemplate(pack, tpl, playbook.id));
  return { playbook, ipp };
}
