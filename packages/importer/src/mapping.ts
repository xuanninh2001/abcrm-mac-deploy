export type Purpose = "accounts" | "contacts" | "blocklist" | "existing_buyers";

export type TargetField =
  | "company_name" | "company_domain" | "hq_state" | "hq_country" | "buyer_type" | "employee_range" | "verticals"
  | "first_name" | "last_name" | "full_name" | "title" | "email" | "phone" | "linkedin_url" | "value";

export type FieldMapEntry = { source: string; target: TargetField; confidence: number };

export const TARGETS: Record<Purpose, { fields: TargetField[]; required: TargetField[][] }> = {
  // `required` is a list of alternatives: at least one group must be fully mapped.
  accounts: { fields: ["company_name", "company_domain", "hq_state", "hq_country", "buyer_type", "employee_range", "verticals"], required: [["company_domain"]] },
  existing_buyers: { fields: ["company_name", "company_domain"], required: [["company_domain"]] },
  contacts: {
    fields: ["company_name", "company_domain", "first_name", "last_name", "full_name", "title", "email", "phone", "linkedin_url", "hq_state"],
    required: [["email"], ["company_domain", "first_name"], ["company_domain", "full_name"]],
  },
  blocklist: { fields: ["value", "email", "company_domain"], required: [["value"], ["email"], ["company_domain"]] },
};

/** Header synonyms seen in Apollo, ZoomInfo, Clay, HubSpot, Lark and hand-made sheet exports. */
const SYNONYMS: Record<TargetField, string[]> = {
  company_name: ["company", "companyname", "account", "accountname", "organization", "organizationname", "business", "businessname", "tencongty", "congty",
    "buyer", "buyername", "advertiser", "advertisername"],
  company_domain: ["domain", "website", "companywebsite", "companydomain", "url", "websiteurl", "site", "web", "companyurl", "advertiserurl", "buyerurl"],
  hq_state: ["state", "hqstate", "companystate", "region", "province", "bang"],
  hq_country: ["country", "hqcountry", "companycountry"],
  buyer_type: ["buyertype", "type", "companytype", "accounttype"],
  employee_range: ["employees", "employeerange", "companysize", "size", "headcount", "numberofemployees", "employeecount"],
  verticals: ["vertical", "verticals", "industry", "industries", "niche", "category", "nganh", "nganhnghe"],
  first_name: ["firstname", "first", "givenname", "fname", "ten"],
  last_name: ["lastname", "last", "surname", "familyname", "lname", "ho"],
  full_name: ["name", "fullname", "contactname", "person", "hoten"],
  title: ["title", "jobtitle", "position", "role", "designation", "chucvu"],
  email: ["email", "emailaddress", "workemail", "businessemail", "mail", "email1", "primaryemail"],
  phone: ["phone", "phonenumber", "mobile", "workphone", "directphone", "sodienthoai", "sdt"],
  linkedin_url: ["linkedin", "linkedinurl", "personlinkedinurl", "linkedinprofile", "profileurl"],
  value: ["value", "blocked", "blocklist", "suppress", "suppression", "emailordomain"],
};

// "đ" has no decomposition, so map it by hand (Vietnamese headers: "Số điện thoại", "SĐT").
const norm = (h: string) => h.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Deterministic header → field proposal. The AI mapper (I1, Phase 1) refines this; a person always confirms. */
export function proposeMapping(headers: string[], purpose: Purpose): FieldMapEntry[] {
  const allowed = new Set(TARGETS[purpose].fields);
  const used = new Set<TargetField>();
  const out: FieldMapEntry[] = [];
  for (const header of headers) {
    const h = norm(header);
    let best: FieldMapEntry | null = null;
    for (const [target, syns] of Object.entries(SYNONYMS) as [TargetField, string[]][]) {
      if (!allowed.has(target) || used.has(target)) continue;
      // Exact synonym = 1. Otherwise a contained synonym (≥ 4 chars) scores 0.5–0.6, higher the nearer it ends to the
      // end of the header: English puts the head noun last ("Advertiser Website" is a website, not a company).
      const ends = syns.filter((s) => s.length >= 4 && h.includes(s)).map((s) => h.lastIndexOf(s) + s.length);
      const confidence = syns.includes(h) ? 1 : ends.length ? 0.5 + 0.1 * (Math.max(...ends) / h.length) : 0;
      if (confidence > (best?.confidence ?? 0)) best = { source: header, target, confidence };
    }
    if (best) { out.push(best); used.add(best.target); }
  }
  return out;
}

export function missingRequired(fieldMap: FieldMapEntry[], purpose: Purpose): TargetField[][] | null {
  const mapped = new Set(fieldMap.map((f) => f.target));
  const ok = TARGETS[purpose].required.some((group) => group.every((f) => mapped.has(f)));
  return ok ? null : TARGETS[purpose].required;
}
