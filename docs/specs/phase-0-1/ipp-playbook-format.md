# Định dạng Supply Profile, IPP, Playbook và quy tắc chấm điểm

Các đối tượng này được lưu trong DB (`supply_profiles`, `ipps`, `playbooks`, `criteria`), có version. Định dạng YAML dưới đây dùng cho **vertical pack templates**, **import/export** và **review**. UI builder đọc/ghi cùng cấu trúc này.

## 1. Supply Profile
```yaml
kind: SupplyProfile
version: 3
verticals: [insurance, finance]
lead_types:
  - vertical: insurance
    type: aca_health
    formats: [data_lead]
    delivery: [ping_post, direct_post]
    exclusivity: [exclusive, shared]
  - vertical: insurance
    type: final_expense
    formats: [data_lead]
    delivery: [direct_post]
traffic_sources: [facebook, native, search]
daily_capacity: { aca_health: 1500, final_expense: 400 }
states: [ALL]                 # hoặc danh sách mã bang
compliance_assets:
  trustedform: true
  jornaya: false
  consent_language_url: https://agency.example/consent
  dnc_scrub: true
  tcpa_seller_naming: per_buyer        # consent nêu tên buyer
positioning: >
  Compliant ACA/FE data leads from in-house media buying, TrustedForm on every lead,
  US-hours QA team. Happy to start with a small capped test.
docs:
  - { kind: rate_card, title: "2026 Q4 rate card", ref: obj://… }
  - { kind: compliance_pack, title: "Consent & QA overview", ref: obj://… }
```

## 2. IPP
```yaml
kind: IPP
name: "ACA & FE data-lead buyers (ping-post / direct post)"
version: 1
vertical: insurance
lead_types: [aca_health, final_expense]
buyer_types: [aggregator, direct_brand, ping_post_exchange]
purchase_formats: [data_lead]
payout_models: [cpl]
size: { employees_min: 10, employees_max: 2000 }
signals:
  web_paths: ["/publishers", "/partners", "/lead-vendors", "/affiliates"]
  tech: [trustedform, jornaya, leadspedia, boberdoo]
  text: ["lead vendor", "publisher program", "posting specs", "ping post"]
exclusions:
  domains: [competitor-a.com]
  keywords: ["we sell leads", "buy our leads"]   # dấu hiệu là publisher/competitor
  buyer_types: [call_buyer]
contact_titles: ["Affiliate Manager", "Director of Partnerships", "Lead Acquisition Manager", "Head of Media Buying", "VP Marketing"]
contacts_per_account: 2
playbook: { lineage: "aca-fe-buyers", version: 1 }
```

## 3. Playbook & quy tắc chấm điểm

```yaml
kind: Playbook
name: "ACA & FE data-lead buyers"
version: 1
tier_thresholds: { A: 75, B: 55, C: 35 }     # % của điểm tối đa có thể đạt
card_min_tier: B
criteria:
  - key: us_operating
    name: Operates in the US
    kind: knockout
    evaluation: rule
    rule: { "==": [ { "var": "account.hq_country" }, "US" ] }
    unknown_policy: neutral              # thiếu HQ country thì không knockout
  - key: not_competitor
    name: Not a competing lead seller
    kind: knockout
    evaluation: ai_judged
    description: "Fail only if evidence shows the company primarily sells the same lead types to buyers."
    hints: [home, about]
  - key: not_flagged
    name: Not blocklisted or existing buyer
    kind: knockout
    evaluation: rule
    rule: { "none": [ { "var": "account.flags" }, { "in": [ { "var": "" }, ["competitor","existing_buyer","do_not_contact"] ] } ] }
  - key: buys_matching_lead_types
    name: Buys ACA or final expense leads
    kind: must_have
    evaluation: ai_judged
    hints: [publishers, partners, careers]
  - key: buys_data_leads_from_publishers
    name: Buys data leads from external publishers (ping-post / direct post)
    kind: must_have
    evaluation: ai_judged
    hints: [publishers, partners]
  - key: uses_lead_distribution_tech
    name: Uses lead distribution / consent tech
    kind: scored
    evaluation: rule
    weight: 10
    rule: { "some": [ { "var": "account.tech_signal_keys" }, { "in": [ { "var": "" }, ["trustedform","jornaya","leadspedia","boberdoo"] ] } ] }
  - key: accepts_offshore_publishers
    name: Accepts publishers outside the US
    kind: scored
    evaluation: ai_judged
    weight: 25
    unknown_policy: neutral
  - key: hiring_affiliate_roles
    name: Hiring affiliate / lead acquisition roles
    kind: scored
    evaluation: ai_judged
    weight: 10
    hints: [careers]
  - key: requires_consent_certs
    name: Requires TrustedForm/Jornaya (fits our assets)
    kind: scored
    evaluation: ai_judged
    weight: 15
  - key: size_fit
    name: Company size fits
    kind: scored
    evaluation: rule
    weight: 10
    rule: { "in": [ { "var": "account.employee_range" }, ["11-50","51-200","201-500","501-1000","1001-5000"] ] }
    unknown_policy: neutral
  - key: no_payment_red_flags
    name: No public payment red flags
    kind: scored
    evaluation: ai_judged
    weight: 20
    unknown_policy: neutral
```

### 3.1 Thuật toán (code, `scorecard.finalize`)
```
Inputs: criteria C, results R (pass|fail|unknown|skipped)

1. Knockout:
   if ∃ c ∈ C.knockout : R[c] = fail                → tier = D, score = 0, stopped_at = c.key
   if ∃ c ∈ C.knockout : R[c] = unknown ∧ c.unknown_policy = block → tier = D (reason: blocked_unknown)

2. Points (scored only):
   for c ∈ C.scored:
     pass    → +c.weight
     fail    → 0
     unknown → neutral: 0  | penalize: −c.unknown_penalty | block: tier ≤ C
   max_points = Σ c.weight over C.scored
   pct = round(100 × max(0, points) / max_points)          (max_points = 0 → pct = 100)

3. Must-have:
   if ∃ c ∈ C.must_have : R[c] = fail     → tier = D
   if ∃ c ∈ C.must_have : R[c] = unknown  → tier cap = C      (cần rep kiểm tra; không lên card nếu card_min_tier = B)
   (must_have pass không cộng điểm; là điều kiện)

4. Tier từ pct: A ≥ t.A, B ≥ t.B, C ≥ t.C, else D; áp cap từ bước 2–3.

5. Evidence rule: criterion có evidence_required = true và result = pass mà không có quote verified
   → result bị ép thành unknown TRƯỚC bước 1 (do criterion.record_result).
```

### 3.2 Ràng buộc khi publish (G-T1)
- Có ít nhất 1 must_have hoặc scored; tổng weight > 0.
- Rule JSONLogic chỉ dùng các biến trong **allowlist**: `account.*` (hq_country, hq_state, employee_range, buyer_type, verticals, lead_types, flags, tech_signal_keys, founded_year), `contacts.count_valid`. Các biến dẫn xuất được rule evaluator tính trước: `account.tech_signal_keys = keys(accounts.tech_signals)`, `contacts.count_valid = số contact có email_verification.result = 'valid'`.
- Preview bắt buộc (≥ 10 mẫu) trước khi submit; kết quả preview đính kèm vào decision G-T1.
- Khi publish version mới: scorecard cũ giữ nguyên (gắn version cũ); re-qualify là hành động tuỳ chọn có ước tính credit.

## 4. Validation (Zod, rút gọn)
```ts
const Criterion = z.object({
  key: z.string().regex(/^[a-z0-9_]{3,48}$/),
  name: z.string().max(80), description: z.string().max(500).optional(),
  kind: z.enum(["knockout","must_have","scored"]),
  evaluation: z.enum(["rule","ai_judged"]),
  rule: JsonLogicAllowlisted.optional(),
  weight: z.number().int().min(0).max(100).default(0),
  evidence_required: z.boolean().default(true),
  unknown_policy: z.enum(["neutral","penalize","block"]).default("neutral"),
  unknown_penalty: z.number().int().min(0).max(50).default(0),
  hints: z.array(z.enum(["home","about","partners","publishers","careers","compliance","pricing","blog"])).default([]),
}).refine(c => (c.evaluation === "rule") === (c.rule !== undefined))
  .refine(c => c.kind !== "scored" || c.weight > 0, "scored criteria need weight")
  .refine(c => c.kind === "scored" || c.weight === 0, "only scored criteria have weight");
```
