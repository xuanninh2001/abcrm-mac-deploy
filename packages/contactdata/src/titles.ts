export type TitleMatch = "exact" | "close" | "weak" | "none";
export type Seniority = "ic" | "manager" | "director" | "vp" | "c_level" | "owner";

const ABBREV: [RegExp, string][] = [
  [/\bmgr\b/g, "manager"], [/\bdir\b/g, "director"], [/\bsr\b/g, "senior"], [/\bjr\b/g, "junior"], [/\bvp\b/g, "vice president"],
  [/\bbiz ?dev\b/g, "business development"], [/\bbd\b/g, "business development"], [/\bhd\b/g, "head"],
];
const MODIFIERS = new Set(["senior", "junior", "lead", "associate", "assistant", "global", "national", "regional", "principal", "staff", "us", "north", "america"]);
const STOP = new Set(["of", "the", "and", "for", "a", "an", "to", "in", "at", "&"]);
/** Words that make a title relevant to lead buying even when it is not on the target list. */
const DOMAIN_WORDS = new Set(["affiliate", "affiliates", "partnership", "partnerships", "partner", "publisher", "publishers", "lead", "leads",
  "acquisition", "media", "buying", "demand", "vendor", "vendors", "growth", "procurement"]);

export function normalizeTitle(title: string): string {
  let t = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[,/|()\-–—.:]+/g, " ");
  for (const [re, rep] of ABBREV) t = t.replace(re, rep);
  return t.replace(/\s+/g, " ").trim();
}

const tokens = (t: string) => normalizeTitle(t).split(" ").filter((w) => w && !STOP.has(w));
const core = (t: string) => tokens(t).filter((w) => !MODIFIERS.has(w));
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((w) => b.includes(w));
const within = (part: string[], whole: string[]) => part.length > 0 && part.every((w) => whole.includes(w));

/**
 * Groups of equivalent titles: each target title plus any pack synonym group it belongs to
 * (vertical-packs/*.yaml contact_titles.synonyms: key → aliases).
 */
export function titleGroups(targets: string[], synonyms: Record<string, string[]> = {}): string[][] {
  const groups = Object.entries(synonyms).map(([key, aliases]) => [key.replace(/_/g, " "), ...aliases]);
  return targets.map((t) => {
    // A target joins a synonym group when it names the same role as one of the group's terms, or extends the
    // group's key (key "lead acquisition" covers the target "Lead Acquisition Manager").
    const g = groups.find((terms) => terms.some((term) => sameSet(core(term), core(t))) || within(core(terms[0]!), core(t)));
    return [t, ...(g ?? [])];
  });
}

/**
 * Rule-based title match (agents.md S2): exact = same words as a target or synonym (ignoring order and
 * seniority modifiers like "Senior"), close = contains all words of a target plus extras, weak = shares a
 * lead-buying keyword, none otherwise.
 */
export function matchTitle(title: string, groups: string[][]): TitleMatch {
  const tc = core(title);
  if (!tc.length) return "none";
  let best: TitleMatch = "none";
  for (const g of groups) {
    for (const term of g) {
      const c = core(term);
      if (!c.length) continue;
      if (sameSet(c, tc)) return "exact";
      if (c.every((w) => tc.includes(w))) best = "close";
    }
  }
  if (best === "none") {
    const stem = (w: string) => w.replace(/(ships|ship|s)$/, "");
    const targetWords = new Set(groups.flat().flatMap(core).filter((w) => DOMAIN_WORDS.has(w)).map(stem));
    if (tc.some((w) => DOMAIN_WORDS.has(w) && targetWords.has(stem(w)))) best = "weak";
  }
  return best;
}

export function seniorityOf(title: string): Seniority {
  const t = normalizeTitle(title);
  if (/\b(founder|co founder|owner|cofounder)\b/.test(t)) return "owner";
  if (/\b(chief|ceo|cmo|coo|cro|cto|cfo|president)\b/.test(t) && !/\bvice president\b/.test(t)) return "c_level";
  if (/\b(vice president|svp|evp|avp)\b/.test(t)) return "vp";
  if (/\b(director|head)\b/.test(t)) return "director";
  if (/\b(manager|lead)\b/.test(t)) return "manager";
  return "ic";
}

const MATCH_RANK: Record<TitleMatch, number> = { exact: 3, close: 2, weak: 1, none: 0 };
const SENIORITY_FIT: Record<Seniority, number> = { director: 3, manager: 3, vp: 2, owner: 1, c_level: 1, ic: 1 };

/** Sort key (higher first): title match × seniority fit × email status (agents.md S2 step 3). */
export function rankScore(m: TitleMatch, s: Seniority, email: "valid" | "catch_all"): number {
  return MATCH_RANK[m] * 100 + SENIORITY_FIT[s] * 10 + (email === "valid" ? 2 : 1);
}
