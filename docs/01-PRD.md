# ABCRM — Product Requirements Document (PRD)

| Mục | Giá trị |
|---|---|
| Sản phẩm | ABCRM: Agentic CRM cho **partner acquisition** của **offshore lead gen agency / B2B affiliate** |
| Phiên bản tài liệu | v0.8 (2026-10-25): chốt mô hình pricing (D28) |
| Tenant (người dùng) | Agency lead gen hoặc affiliate đặt **ngoài US** (VN, PH, IN, LATAM…) |
| Đối tượng được tiếp cận | **Lead buyers tại US**: brand (direct buyer), lead aggregator, affiliate network, pay-per-call buyer |
| Verticals | **Education, Insurance, Finance, Legal, Home Services** |
| Mô hình | SaaS multi-tenant, dữ liệu lưu tại US; pháp nhân Singapore |
| Liên quan | [`02-system-design.md`](./02-system-design.md), [`03-roadmap.md`](./03-roadmap.md), [`04-pricing-and-metering.md`](./04-pricing-and-metering.md), [`05-data-import.md`](./05-data-import.md), [`06-vertical-packs.md`](./06-vertical-packs.md) |

### Nhật ký quyết định
| # | Quyết định | Trạng thái |
|---|---|---|
| D1–D6 | Ngành lead gen; SaaS multi-tenant; solo founder; seat + credit, không giới hạn agent; human gates; import Salesforce/HubSpot/Lark/Excel | Giữ |
| D7 | Outbound tới SMB và giao lead realtime cho partner | **Thay thế bởi D13** |
| D8 | Grouped review được tính là duyệt từng item | Giữ |
| D9 | Verticals Edu/Insurance/Home Services/Finance | **Mở rộng bởi D17** |
| D10 | US trước (người được tiếp cận ở US) | Giữ |
| D11 | Pháp nhân Singapore | Giữ |
| D12 | Đề xuất bị từ chối vẫn tính credit | Giữ |
| **D13** | **Khách đầu tiên: offshore lead gen agency / B2B affiliate. ABCRM phục vụ việc tìm, qualify, tiếp cận và ký hợp đồng với lead buyers tại US** | Mới |
| **D14** | **Lead Sourcing Agent** tìm doanh nghiệp theo **chân dung partner mục tiêu** (Ideal Partner Profile) | Mới |
| **D15** | **Qualification Agent** chấm theo **bộ tiêu chí do khách tự tuỳ chỉnh** (Qualification Playbook) | Mới |
| **D16** | **Chỉ liên hệ business lead đã qualify VÀ được sales rep của tenant phê duyệt** (gate G-Q, từng lead) | Mới |
| **D17** | Verticals: Edu, Insurance, Finance, **Legal**, Home Services | Mới |
| **D18** | Follow-up từ template đã duyệt (chỉ merge field, không có nội dung AI) gửi cho lead đã qua G-Q **được coi là đã duyệt** (Q7) | Mới |
| **D19** | Tenant đầu tiên bán **data lead** (CPL); IPP/playbook mặc định nhắm buyer mua data lead (Q11) | Mới |
| **D20** | Tracking platform ưu tiên tích hợp: **RedTrack** (Q12) | Mới |
| **D21** | **ABCRM cung cấp contact data** cho tenant, tính trong credit (Q13), đi kèm meter riêng *Contact Credits* | Mới |
| **D22** | Pricing offshore: **seat rẻ, doanh thu chủ yếu từ credit** (Q14) | Mới |
| **D23** | Nhiều tenant nhắm cùng buyer: **global contact pressure** (đếm ẩn danh theo domain người nhận, hoãn gửi khi vượt ngưỡng); không chia sẻ dữ liệu giữa tenant (Q15) | Mới |
| **D24** | Thứ tự vertical pack: **Insurance, Finance, Home Services** trước; **Education** sau; Legal sau cùng (Q16) | Mới |
| **D25** | RedTrack: buyer được ghi nhận dưới dạng **Offer Source**; mapping 1 buyer account ↔ 1..n offer source (Q17) | Mới |
| **D26** | Contact data MVP: **email verified + LinkedIn profile URL (nếu provider có)**; không có số điện thoại (Q18) | Mới |
| **D27** | **Intent Signals**: lắng nghe buyer intent công khai ("need affiliates / media buyers for offer X in vertical Y") từ nguồn hợp lệ; **không scrape hay truy cập tự động LinkedIn**; Phase 2 | Mới |
| **D28** | **Pricing: không giới hạn số agent, cap theo volume (credit) và công suất** (concurrency, monitor, mailbox). Trang pricing nói bằng kết quả ("buyer cards/tháng"); upsell theo năng lực (template theo plan); spend cap mặc định (Starter hard stop, Growth+ cap = 50% giá plan); guardrails theo agent (budget, anomaly alert, circuit breaker). Xem `04-pricing-and-metering.md` §2–3 | Mới |

> **Hệ quả của D13:** việc giao lead tiêu dùng (consumer lead) cho buyer **không làm trong ABCRM**. Agency đã dùng tracking platform (tenant đầu tiên dùng **RedTrack**, D20). ABCRM **tích hợp** để theo dõi hiệu quả và doanh thu theo buyer (Phase 2). Delivery engine, handoff consent và return flow của v0.3 ra khỏi phạm vi.

---

## 1. Bối cảnh & bài toán

Agency offshore có **nguồn traffic hoặc lead** (call center, media buying, SEO, email, social) và cần **người mua ổn định ở US**. Phát triển kinh doanh (BD) hiện nay của họ:
- Tự tìm buyer qua Google, LinkedIn, hội chợ (LeadsCon, Affiliate Summit…), directory affiliate, giới thiệu, nhóm Telegram/Skype.
- Ghi chép trong sheet; gửi email lạnh hàng loạt, trúng sai đối tượng; follow-up không đều.
- Khó đánh giá buyer: có mua đúng loại lead không, chấp nhận publisher offshore không, payout và terms ra sao, **có trả tiền đúng hạn không**.
- Rào cản niềm tin: buyer US e ngại publisher offshore (chất lượng, compliance, gian lận).
- Lệch múi giờ: đội BD ở châu Á, buyer ở US.

### 1.1 Funnel mới

```
TOFU ─ Partner Discovery
  Ideal Partner Profile ─► Sourcing Agent ─► Enrich & Find contacts ─► Qualification Agent (scorecard)
        [G-T1 duyệt IPP + Playbook]                                          │
                                                                              ▼
                                   [G-Q  Sales rep duyệt "Approve to Contact" + email đầu tiên]
MOFU ─ Engagement                                                              │
  Sequence (template đã duyệt) ─► Reply ─► Hội thoại [G-OUT] ─► Meeting ─► Discovery
                                                         [G-M1 tạo Opportunity] / [G-M2 loại / nuôi lại]
BOFU ─ Partnership
  Đề xuất terms (vertical, lead type, payout, cap, compliance) [G-B1] ─► Test/IO ─► Close [G-B2]
  ─► Onboarding ─► Live ─► Performance & công nợ (từ RedTrack, Phase 2)
```

## 2. Tầm nhìn
> **"BD team gồm AI cho agency lead gen":** agent tìm đúng buyer, nghiên cứu kỹ, chấm điểm theo tiêu chí riêng của agency. **Sales rep chỉ duyệt ai được liên hệ và nội dung gửi đi.** Mỗi buyer được tiếp cận đều có hồ sơ bằng chứng: họ mua gì, trả thế nào, vì sao phù hợp.

## 3. Personas
| Persona | Bối cảnh | Nhu cầu |
|---|---|---|
| **Agency Owner / Head of BD** (offshore) | Quyết định chiến lược buyer, terms | IPP rõ ràng, pipeline buyer chất lượng, rủi ro thanh toán thấp |
| **Sales Rep / BD Manager** (offshore, giờ châu Á) | Người dùng chính hằng ngày | Mở app buổi sáng (giờ châu Á) thấy danh sách lead đã qualify kèm bằng chứng; duyệt nhanh; email gửi đúng giờ làm việc US |
| **Account Manager** | Quản lý buyer đã ký | Terms, test campaign, hiệu quả, công nợ |
| **Admin / Ops** | Cấu hình | Mailbox, playbook, quyền, credit |

*(Không có Partner Portal trong MVP; buyer không đăng nhập ABCRM.)*

## 4. Mục tiêu & KPI
- **North Star:** *Số buyer mới ký (live) mỗi tháng trên mỗi tenant* (leading indicator: *meeting được đặt với buyer đã qualify*).
- Qualification precision: ≥ 80% lead được agent xếp hạng A được rep duyệt liên hệ.
- Thời gian rep duyệt một lead (card) < 30 giây trung vị.
- Positive reply rate ≥ 2× so với cách làm hiện tại của tenant (baseline đo khi onboarding).
- Bounce < 2%, complaint rất thấp; 0 email gửi tới lead chưa được duyệt.
- Gross margin ≥ 70%.

## 5. Khái niệm sản phẩm cốt lõi

### 5.1 Supply Profile (năng lực của agency)
Hồ sơ mô tả **agency bán được gì**, dùng cho sourcing, matching và viết nội dung:
- Verticals và **lead types** (ví dụ Insurance: Medicare, ACA, auto, final expense; Legal: MVA, mass tort, SSDI; Finance: debt relief, personal loan, tax relief; Edu: online degree, trade school; Home Services: solar, roofing, HVAC, remodeling).
- **Hình thức**: data lead, live transfer, inbound call (pay-per-call), appointment. **Mặc định MVP: data lead (CPL)** (D19), gồm cách giao (ping-post, direct post qua API, batch), posting spec, return rate lịch sử.
- **Traffic sources**: search, social, native, email, SMS, call center, SEO.
- Volume/ngày, bang US phủ được, giờ hoạt động.
- **Compliance assets**: TrustedForm/Jornaya, consent language, DNC scrub, call recording, quy trình QA.
- Case study, reference, payout lịch sử (nếu có).

### 5.2 Ideal Partner Profile (IPP): chân dung partner mục tiêu (D14)
Mỗi tenant tạo **nhiều IPP**, ví dụ "Medicare aggregators mua live transfer" hoặc "MVA law firms mua signed retainers":
| Nhóm thuộc tính | Ví dụ |
|---|---|
| Buyer type | Direct brand/carrier/law firm/school; Aggregator; Affiliate network; Ping-post exchange; Call buyer |
| Vertical & lead type | Insurance → Medicare, final expense |
| Hình thức mua | Data lead, live transfer, pay-per-call, appointment |
| Payout model | CPL, CPA, pay-per-call (duration), rev share |
| Quy mô | Nhân sự, doanh thu ước tính, số bang hoạt động |
| Tín hiệu (signals) | Có trang "Partners/Publishers/Affiliates", tuyển "affiliate manager/media buyer", website có script TrustedForm/Jornaya, dùng tracking platform (Everflow, CAKE, TUNE, LeadsPedia, boberdoo, Ringba), có mặt ở hội chợ ngành, đang chạy quảng cáo trong vertical |
| Loại trừ | Đối thủ trực tiếp, buyer đã từng làm việc, công ty có dấu hiệu chậm thanh toán |
| Chức danh người liên hệ | Affiliate/Partnerships Manager, Director of Media Buying, VP Growth, Head of Acquisition, Founder (công ty nhỏ) |

### 5.3 Qualification Playbook: bộ tiêu chí tuỳ chỉnh (D15)
Tenant tự định nghĩa tiêu chí (có template theo vertical). Mỗi tiêu chí:
| Thuộc tính | Mô tả |
|---|---|
| `name`, `description` | Ví dụ "Accepts offshore publishers": mô tả bằng ngôn ngữ tự nhiên |
| `kind` | **knockout** (vi phạm thì loại), **must_have** (phải có bằng chứng), **scored** (cộng điểm) |
| `evaluation` | **rule** (JSONLogic trên dữ liệu có cấu trúc) hoặc **ai_judged** (agent tìm bằng chứng và phán đoán) |
| `weight` | Trọng số cho `scored` |
| `evidence_required` | Bắt buộc có trích dẫn nguồn (URL, đoạn văn bản, field dữ liệu) |
| `unknown_policy` | Thiếu dữ liệu thì: trung tính / trừ điểm / chặn (cần rep xem) |
| `hints` | Gợi ý nơi tìm (trang partners, job posts, tech stack, review) |

Kết quả: **Scorecard** cho mỗi business lead gồm từng tiêu chí (pass / fail / unknown, confidence, bằng chứng), tổng điểm, **Tier A/B/C/D** (D là disqualified) và tóm tắt "vì sao phù hợp".

Ví dụ tiêu chí (thêm tiêu chí mặc định **"Có intent signal trong 14 ngày"**, loại scored, có trọng số cao, từ D27):
- Knockout: "Không phải đối thủ cung cấp cùng loại lead"; "Không nằm trong blocklist"; "Có hoạt động tại US".
- Must-have: "Mua lead type khớp Supply Profile"; "Có bằng chứng đang mua từ publisher bên ngoài".
- Scored: "Chấp nhận offshore/call center ngoài US" (30); "Payout model là pay-per-call" (20); "Có tracking platform chuẩn" (10); "Đang tuyển affiliate manager" (10); "Không có phản hồi xấu về thanh toán" (20).

Playbook có **version**; mỗi scorecard ghi version đã dùng. **Calibration**: agent phân tích các lần rep duyệt/từ chối để **đề xuất** chỉnh trọng số hoặc thêm tiêu chí; thay đổi phải được admin duyệt (G-T1).

### 5.4 Intent Signals (D27)
**Intent signal** là bằng chứng công khai, có thời điểm, rằng một buyer **đang cần** traffic hoặc publisher. Ví dụ: bài đăng "Looking for affiliates/media buyers for ACA offer", tin tuyển "Affiliate Manager – Insurance", offer mới mở trên affiliate network.

**Signal Monitor** do tenant tạo (không giới hạn số monitor tạo ra; số monitor **đang chạy** giới hạn theo plan):
| Thuộc tính | Ví dụ |
|---|---|
| Từ khoá / cụm từ | "need affiliates", "looking for media buyers", "seeking publishers", "lead vendors wanted" |
| Vertical & lead type | Insurance → ACA, Medicare, final expense |
| Nguồn | Search-indexed public posts, job postings, offer directories, Reddit, rep tự gửi vào (Phase sau: X, Telegram public channels) |
| Loại trừ | "hiring" cho vị trí không liên quan, từ khoá của đối thủ |
| Lịch quét | Mỗi 1–6 giờ tuỳ nguồn |
| Gắn IPP/Playbook | Tín hiệu khớp sẽ được qualify theo playbook nào |

**Phân loại bắt buộc** (giữ hoặc loại):
| Nhãn | Ý nghĩa | Xử lý |
|---|---|---|
| `buyer_seeking_supply` | Buyer cần publisher, traffic hoặc lead | **Giữ**, ưu tiên cao |
| `buyer_hiring_affiliate_role` | Buyer tuyển affiliate/media/publisher manager | Giữ, ưu tiên trung bình |
| `new_offer_in_vertical` | Offer mới trên network/directory | Giữ, ưu tiên trung bình |
| `publisher_seeking_buyers` | Publisher hoặc agency khác đang tìm buyer (**đối thủ**) | Loại (có thể dùng để phân tích thị trường) |
| `job_seeker`, `spam`, `irrelevant` | — | Loại |

**Chính sách nguồn**:
- Không đọc LinkedIn trực tiếp. Bài LinkedIn chỉ đến qua **tiêu đề, đoạn trích và URL từ web search API**, hoặc do **rep tự gửi vào**.
- Không đọc nhóm hay diễn đàn cần đăng nhập.
- Tôn trọng ToS của từng nguồn.

**Độ mới**: tín hiệu có `observed_at`. Ưu tiên giảm dần, mạnh nhất trong 72 giờ đầu, mặc định hết hạn sau 14 ngày.

### 5.5 Approve-to-Contact Card (D16)
Một thẻ trong Decision Inbox cho mỗi business lead đã qualify (Tier A/B, hoặc theo ngưỡng tenant):
```
┌──────────────────────────────────────────────────────────────────────┐
│ Acme Health Leads LLC · Aggregator · Insurance (Medicare, FE) · FL   │
│ Tier A · 86/100 · Playbook "Medicare Buyers" v3                       │
│ ✔ Buys Medicare live transfers   [src: acmehl.com/partners ¶2]        │
│ ✔ Accepts call centers outside US [src: job post "offshore QA" 09/26] │
│ ? Payment reputation: unknown                                         │
│ ✖ —                                                                   │
│ Contacts: Jane Doe — Dir. Partnerships (verified) ☑ · John Roe ☐     │
│ First email (preview, AI line highlighted)            [Edit]          │
│ [Approve & queue]  [Approve, no email yet]  [Reject ▾ reason]  [Snooze] │
└──────────────────────────────────────────────────────────────────────┘
```
- **Approve** ghi đồng thời: G-Q (được liên hệ) và G-OUT cho email đầu tiên (đã xem trước).
- **Reject** bắt chọn lý do (sai vertical, đối thủ, quá nhỏ, đã liên hệ, uy tín xấu…). Lý do là dữ liệu calibration.
- Hỗ trợ **grouped review** (D8): xem dạng bảng các card cùng IPP, duyệt hàng loạt sau khi lướt.
- **Không có đường nào** đưa một lead chưa có G-Q `approved` vào sequence hay gửi bất kỳ tin nào (platform invariant).

## 6. Decision Gates (v0.4)
| Gate | Funnel | Quyết định | Ai duyệt |
|---|---|---|---|
| **G-T1** | TOFU | Tạo/sửa **IPP**, **Qualification Playbook**, Supply Profile; chạy sourcing lớn (ước tính credit) | Admin / Head of BD |
| **G-T2** | TOFU | Sequence và template | Head of BD |
| **G-Q** | TOFU→MOFU | **Approve to Contact**: lead nào, người nào được liên hệ (từng lead) | **Sales Rep** |
| **G-OUT** | Mọi stage | Mọi tin do AI soạn gửi ra ngoài: email đầu tiên (trong card G-Q), reply, email đề xuất terms | Sales Rep |
| **G-M1** | MOFU | Chuyển thành **Opportunity** (buyer quan tâm hoặc đã có meeting) | Sales Rep |
| **G-M2** | MOFU | Disqualify / nuôi lại sau N ngày | Sales Rep |
| **G-B1** | BOFU | **Đề xuất terms/IO** gửi buyer (vertical, lead type, payout, cap, test budget, payment terms) | Head of BD |
| **G-B2** | BOFU | Close won/lost, chuyển sang Live | Head of BD |

**Follow-up theo sequence (D18, đã chốt):** follow-up dùng **template đã duyệt ở G-T2, chỉ có merge field, không có nội dung AI**, gửi cho lead đã qua G-Q, được coi là đã phê duyệt. Follow-up có nội dung AI vẫn qua G-OUT. Send guard vẫn kiểm tra lại suppression, geo, giờ gửi và các điều kiện khác ngay trước mỗi lần gửi.

**Agent tự làm (không gate):** sourcing, enrich, tìm contact, verify email, chấm scorecard, tóm tắt, phân loại reply, tạo task, xử lý unsubscribe/bounce (luôn tự động, miễn phí, không bao giờ dừng), auto-pause mailbox.

## 7. Agent Template Catalog (v0.4)
| # | Template | Funnel | Làm gì | Gate | Phase |
|---|---|---|---|---|---|
| **S1** | **Lead Sourcing Agent** | TOFU | Từ IPP: lập kế hoạch tìm kiếm (từ khoá, directory, tín hiệu), tìm qua web search API, đọc website (trang partners/affiliates, careers, about), nhận diện tech signals, kết hợp dữ liệu import/provider; dedupe với CRM và blocklist; mỗi candidate có **evidence** | — (sourcing run lớn cần G-T1) | 1 |
| **S2** | **Contact Finder & Verifier** | TOFU | Tìm người đúng chức danh qua **Contact Data Layer của ABCRM** (waterfall nhiều provider, D21) hoặc file import; verify email; lấy LinkedIn profile URL nếu provider có (D26); chọn contact chính/phụ; chỉ tính Contact Credit khi tìm được email verified | — | 1 |
| **Q1** | **Qualification Agent** | TOFU | Chạy Playbook: rule criteria (deterministic) và ai_judged criteria (nghiên cứu, trích dẫn); scorecard; tier; tóm tắt "why fit"; tạo **Approve-to-Contact card** | G-Q | 1 |
| **W1** | **Outreach Writer** | TOFU | Soạn sequence (G-T2) và email đầu tiên cá nhân hoá theo scorecard và Supply Profile (trong card G-Q) | G-T2, G-Q/G-OUT | 1 |
| **R1** | **Reply Handler** | MOFU | Phân loại reply (interested, send info, not now, wrong person (kèm người được giới thiệu), unsubscribe, OOO); soạn trả lời (gửi rate card, case study, compliance pack, đề xuất lịch họp) | G-OUT | 1 |
| **M1** | **Meeting Prep & Notes** | MOFU | Brief trước meeting (buyer mua gì, payout dự kiến, câu hỏi discovery); sau meeting: tóm tắt, cập nhật Opportunity, next steps | G-M1 | 2 |
| **B1** | **Terms & Proposal Drafter** | BOFU | Soạn đề xuất terms/IO từ Supply Profile và nhu cầu buyer; kiểm tra margin, payment terms (prepay/net) | G-B1 | 2 |
| **D1** | **Buyer Due Diligence** | TOFU/BOFU | Kiểm tra uy tín: tuổi công ty, đăng ký kinh doanh, tín hiệu công khai về thanh toán, kiện tụng/khiếu nại công khai, danh sách đen ngành (nguồn tenant cung cấp) | Gắn vào scorecard | 2 |
| **P1** | **Partnership Performance** | Post-sale | Đồng bộ từ **RedTrack** (D20): conversions, revenue, trạng thái conversion theo offer/offer source được map với buyer; cảnh báo buyer giảm volume, tăng tỉ lệ từ chối hoặc chậm trả | Chỉ đề xuất | 2 |
| **H1** | **Deliverability Guardian** | — | Như v0.3: theo dõi mailbox, auto-pause | auto | 1 |
| **C1** | **Copilot** | — | Hỏi đáp pipeline, tìm buyer tương tự | theo hành động | 2 |
| **I1** | **Import Mapper** | — | Mapping import (miễn phí) | duyệt mapping | 1 |
| **K1** | **Playbook Calibrator** | — | Đề xuất chỉnh tiêu chí từ lịch sử duyệt/từ chối và kết quả (meeting, won) | G-T1 | 2 |
| **L1** | **Intent Listener** (D27) | TOFU | Chạy Signal Monitor trên các nguồn hợp lệ; phân loại tín hiệu (buyer cần supply hay publisher tìm buyer); trích xuất vertical, lead type, offer, độ mới; gắn với Account; đẩy vào qualification **fast-track** | — (card G-Q như thường) | 2 |

Tenant tạo **không giới hạn agent** từ template, ví dụ một Sourcing Agent cho mỗi IPP (D4).

## 8. Yêu cầu chức năng (MVP = M)

### 8.1 Sourcing & Qualification
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-S01 | Supply Profile (form có cấu trúc kèm tài liệu đính kèm: rate card, case study, compliance pack) | M |
| FR-S02 | IPP builder (nhiều IPP mỗi tenant), template IPP theo 5 vertical | M |
| FR-S03 | Sourcing Run: chạy theo IPP với **ngân sách credit** và số candidate mục tiêu; tiến độ realtime; dừng/tiếp tục | M |
| FR-S04 | Nguồn candidate: web search API, đọc website công khai (tôn trọng robots.txt, rate limit), file import (danh sách hội chợ, directory, LinkedIn Sales Navigator export do người dùng tự xuất), **dữ liệu công ty từ Contact Data Layer của ABCRM** | M |
| FR-S05 | **Evidence store**: mỗi phát hiện có URL, đoạn trích, thời điểm truy cập; ảnh chụp/HTML lưu tối thiểu để kiểm chứng | M |
| FR-S06 | Tech signal detection (script/pixel của tracking platform, TrustedForm/Jornaya) từ HTML trang công khai | M |
| FR-S07 | Dedupe theo domain với CRM, blocklist, đối thủ, "đã liên hệ trong N ngày" | M |
| FR-S08 | Qualification Playbook builder: tiêu chí knockout/must/scored, rule/ai_judged, weight, unknown policy; version; preview trên 20 lead mẫu trước khi publish | M |
| FR-S09 | Scorecard với trích dẫn cho mọi tiêu chí ai_judged; trích dẫn được **kiểm chứng tồn tại** trong evidence | M |
| FR-S10 | Re-qualify khi playbook đổi version (tuỳ chọn, ước tính credit trước) | S |
| FR-S11 | Calibration report: precision theo tier, lý do từ chối phổ biến, đề xuất chỉnh | S |
| FR-S12 | **Contact Data Layer** (D21): tìm contact theo company và chức danh qua waterfall provider do ABCRM ký hợp đồng; verify email; trả về **email verified và LinkedIn URL nếu có** (không có phone, D26); chỉ tính phí khi có email verified; hiển thị nguồn dữ liệu | M |
| FR-S13 | **Global data suppression**: người đã yêu cầu xoá hoặc opt-out với ABCRM (với vai trò bên cung cấp dữ liệu) không bao giờ được cung cấp lại cho bất kỳ tenant nào | M |
| FR-S15 | **Signal Monitors** (D27): tạo, sửa, bật, tắt; từ khoá, vertical, nguồn, loại trừ, lịch quét, gắn IPP/Playbook; xem trước kết quả 7 ngày gần nhất trước khi bật | S (Phase 2) |
| FR-S16 | Source adapters hợp lệ: web search API (gồm bài đăng công khai đã được index, chỉ đọc snippet và URL), job postings API, offer directories/RSS, Reddit API | S (Phase 2) |
| FR-S17 | **Manual signal capture**: rep dán URL hoặc nội dung, forward email tới địa chỉ riêng của tenant, hoặc dùng nút "Save to ABCRM" (chỉ ghi trang rep đang xem khi rep **chủ động bấm**, không tự đọc nền) | S (Phase 2) |
| FR-S18 | Signal classification (nhãn ở §5.4) có eval riêng; tín hiệu loại vẫn lưu kèm lý do để rà soát | S (Phase 2) |
| FR-S19 | Fast-track: tín hiệu khớp thì tạo candidate hoặc gắn vào account có sẵn, qualify ngay, tạo card G-Q ở làn **hot-intent** với badge Intent, đoạn trích và link nguồn | S (Phase 2) |
| FR-S20 | Signal feed: danh sách tín hiệu theo monitor, lọc theo vertical, độ mới, trạng thái (new, carded, contacted, dismissed) | S (Phase 2) |
| FR-S21 | X/Twitter API, Telegram public channels | C (sau, tuỳ kết quả phỏng vấn) |
| FR-S14 | Data lead buyer signals: phát hiện posting spec/API docs công khai, ping-post platform (LeadsPedia, boberdoo…), trang "lead vendor/publisher" | M |

### 8.2 Approval & Outreach
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-O01 | **Approve-to-Contact card** (G-Q + email đầu tiên), grouped review, lý do từ chối bắt buộc | M |
| FR-O02 | Mailbox Google Workspace / Microsoft 365 qua OAuth; pool; ramp; giới hạn | M |
| FR-O03 | Domain check SPF/DKIM/DMARC; khuyến nghị domain gửi riêng | M |
| FR-O04 | Sequence; **lịch gửi theo giờ làm việc của người nhận ở US**; rep duyệt trong giờ châu Á, hệ thống tự xếp lịch | M |
| FR-O05 | Send guard: G-Q approved, approval nội dung hợp lệ, suppression, US-only, giờ gửi, mailbox limits, domain, footer/List-Unsubscribe | M |
| FR-O06 | Reply sync realtime, unified inbox, phân loại reply | M |
| FR-O07 | **Kênh thủ công**: agent soạn tin LinkedIn/Telegram/WhatsApp/Teams; rep tự gửi bằng tay rồi đánh dấu "sent" (không tự động hoá LinkedIn) | S |
| FR-O08 | Booking link của rep (Calendly/Google/MS Bookings) trong email; ghi nhận meeting | S |
| FR-O09 | Unsubscribe/bounce tự động vào suppression | M |

### 8.3 Pipeline & Partnership
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-P01 | Account (buyer company), Contact, Opportunity với pipeline mặc định: `Contacted → Engaged → Meeting → Negotiation → Test → Won/Live · Lost` | M |
| FR-P02 | **Partnership terms** có cấu trúc: vertical, lead type, hình thức, payout model và giá, cap, bang, giờ nhận, yêu cầu compliance, payment terms (prepay, net 7/15/30), test budget | M |
| FR-P03 | Activities, tasks, notes, timeline 360° | M |
| FR-P04 | Tài liệu gửi buyer: rate card, compliance pack (link có tracking lượt xem tuỳ chọn) | S |
| FR-P05 | Tích hợp **RedTrack** (read-only, API key của tenant): map **Offer Source** với buyer account (D25); đồng bộ hằng ngày conversions, revenue, trạng thái; báo cáo doanh thu theo buyer | S (Phase 2) |
| FR-P07 | Tích hợp tracking platform khác (Everflow, CAKE, LeadsPedia, boberdoo…) | C |
| FR-P06 | Công nợ đơn giản: invoice, ngày đến hạn, quá hạn, cảnh báo | C (Phase 3) |

### 8.4 Agent Platform, Import, Billing
Giữ như các phiên bản trước: Decision Inbox, gates bất biến, templates và unlimited tenant agents, delegated identity, audit, undo, knowledge base (Supply Profile, case study), metering (D12), kill switch, feedback; import CSV/Excel và HubSpot (M), Salesforce và Lark (S); Stripe (SG) với Stripe Tax; roles **Owner, Admin, Head of BD, Sales Rep, Viewer**.

Bổ sung cho bối cảnh offshore:
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-X01 | Mỗi user có **múi giờ làm việc** riêng; SLA của Decision Inbox tính theo giờ làm việc của rep | M |
| FR-X02 | UI tiếng Anh; **tiếng Việt** là ngôn ngữ thứ hai (nhiều tenant đầu tiên ở VN); nội dung gửi buyer luôn là tiếng Anh US | S |
| FR-X03 | "Writing quality guard": email theo chuẩn tiếng Anh US, không dùng cụm từ khiến buyer nghi ngờ (spammy, quá hứa hẹn) | M |

## 9. User stories

**US-01: Sourcing theo IPP**
> Là Head of BD, tôi tạo IPP "Final expense & Medicare buyers mua live transfer, chấp nhận call center offshore" và muốn có 200 công ty phù hợp trong tuần.
- G-T1: duyệt IPP và playbook; ước tính khoảng X credit cho 200 candidate.
- S1 tìm candidate, có evidence; S2 tìm 1–2 contact mỗi công ty và verify; Q1 chấm scorecard.
- Kết quả: khoảng 60 Tier A/B tạo thành card G-Q; số còn lại lưu với lý do loại (có thể xem lại).

**US-02: Duyệt buổi sáng ở Hà Nội**
> Là Sales Rep, lúc 9h sáng giờ VN tôi duyệt 40 card trong 20 phút.
- Lướt theo nhóm IPP, mở chi tiết khi cần, sửa câu mở đầu ở 5 email, từ chối 6 lead (lý do: đối thủ 2, quá nhỏ 3, đã liên hệ 1).
- Email đầu tiên xếp lịch 9h–11h sáng theo giờ địa phương của từng người nhận ở US (tức tối hoặc đêm cùng ngày giờ VN).

**US-04: Intent signal**
> Monitor "ACA / final expense – need publishers" bắt được kết quả search: bài đăng công khai của Director of Partnerships tại một agency bảo hiểm, nội dung "Looking for data lead publishers for ACA, TrustedForm required".
- L1 phân loại `buyer_seeking_supply` (vertical Insurance, lead type ACA, yêu cầu TrustedForm); xác định công ty; account chưa có trong CRM nên tạo candidate.
- Q1 qualify fast-track (tiêu chí intent pass, kèm đoạn trích làm bằng chứng); S2 tìm contact (ưu tiên đúng người đã đăng nếu provider có).
- Card G-Q ở làn hot-intent, có link bài gốc để rep mở xem. Email đầu tiên nhắc đúng nhu cầu: "Saw you're looking for ACA data lead publishers with TrustedForm…". Rep duyệt, email gửi trong giờ làm việc kế tiếp ở US.

**US-03: Reply qua đêm**
> Buyer trả lời lúc 2h sáng giờ VN: "Interested, what's your CPL for Medicare live transfers and do you have TrustedForm?"
- R1 phân loại `interested`; soạn reply kèm rate card và compliance pack từ Supply Profile, đề xuất 3 khung giờ họp (giờ US) → card G-OUT ở làn hot.
- Rep duyệt lúc 8h sáng VN; R1 đề xuất G-M1 tạo Opportunity.

## 10. Yêu cầu phi chức năng
| ID | Yêu cầu |
|---|---|
| NFR-PERF | Card G-Q mở < 1s; scorecard một lead (ai_judged) p95 < 3 phút; reply → card hot < 2 phút |
| NFR-SCALE (năm 1–2) | 300 tenant; ~1M candidate nghiên cứu/tháng; ~3M email/tháng; 30k card G-Q/ngày |
| NFR-CRAWL | Crawler lịch sự: tôn trọng robots.txt, rate limit theo domain, user-agent định danh, chỉ trang công khai, không vượt login/paywall/CAPTCHA |
| NFR-ISO, SEC, AUDIT, OPS | Như cũ: RLS, cross-tenant test, mã hoá field PII, audit append-only, managed services |
| NFR-RES | Dữ liệu ở US (cell `us`) |
| NFR-COST | Chi phí biến đổi/credit ≤ 30% giá overage; sourcing và qualification là phần tốn nhất, nên cần budget theo run |

## 11. Compliance
> Cần luật sư US và Singapore review.

| Khung | Yêu cầu sản phẩm |
|---|---|
| **CAN-SPAM** | Áp dụng cho email thương mại tới người nhận US **dù người gửi ở nước ngoài**: opt-out xử lý ngay, địa chỉ bưu chính của tenant, header không gây hiểu nhầm |
| **Yêu cầu của mailbox provider** | SPF/DKIM/DMARC, one-click unsubscribe, giới hạn volume, giám sát bounce/complaint |
| **CCPA/CPRA và luật privacy các bang** | Contact B2B ở California thuộc phạm vi: lưu **nguồn dữ liệu** của từng contact, hỗ trợ yêu cầu truy cập/xoá/opt-out; ABCRM là service provider của tenant |
| **Thu thập dữ liệu web** | Chỉ trang công khai; tôn trọng robots.txt và ToS; **không scrape LinkedIn** (chỉ nhận file export người dùng tự tạo); lưu đoạn trích tối thiểu làm bằng chứng |
| **Intent Signals (D27)** | Mỗi nguồn dùng đúng kênh được phép (search API, API chính thức như Reddit/X, RSS, trang công khai). **LinkedIn**: không truy cập tự động, không extension đọc nền; chỉ dùng snippet và URL từ search API, hoặc nội dung rep tự gửi vào. Không đọc nhóm hay kênh cần đăng nhập. Lưu tối thiểu (snippet, URL, thời điểm), có TTL. Tác giả bài đăng là dữ liệu cá nhân: lưu nguồn và áp dụng DSAR/suppression như contact |
| **Geo guard** | Chỉ gửi tới người nhận ở US; chặn EU/UK/Canada |
| **Singapore PDPA** | ABCRM là data intermediary; DPA với tenant |
| **Luật dữ liệu nơi tenant đặt trụ sở** | Tenant ở VN (Luật Bảo vệ dữ liệu cá nhân), PH (Data Privacy Act), IN (DPDP Act) có nghĩa vụ riêng với dữ liệu nhân sự và hoạt động xử lý của họ, nên nêu trong ToS/DPA |
| **AUP** | Cấm dùng ABCRM để bán dữ liệu không consent, spam, hoặc mạo danh |
| **ABCRM là bên cung cấp contact data (D21)** | Khi ABCRM cung cấp dữ liệu contact cho tenant, ABCRM có thể bị coi là **data broker** theo luật một số bang (ví dụ California Delete Act và nền tảng xoá dữ liệu tập trung DROP, Texas, Vermont, Oregon). Cần luật sư đánh giá: đăng ký data broker, xử lý yêu cầu xoá/opt-out ở cấp ABCRM (FR-S13), thông báo nguồn dữ liệu. **Hợp đồng với provider phải cho phép dùng dữ liệu trong sản phẩm bán cho khách** (embedded/resale license), quy định rõ cache, thời gian lưu và chia sẻ giữa khách |

*Lưu ý:* compliance của **consumer lead** mà agency bán (TCPA, consent) là trách nhiệm của agency và nằm trên tracking platform của họ; ABCRM chỉ lưu **compliance assets** trong Supply Profile để giới thiệu cho buyer.

## 12. Ngoài phạm vi MVP
- Giao consumer lead, ping-post, return/dispute (dùng tracking platform của agency).
- Partner Portal cho buyer.
- Tự động hoá LinkedIn / Telegram / WhatsApp (chỉ soạn nháp, gửi tay).
- Intent Signals (D27) không nằm trong MVP Phase 1 (làm ở Phase 2); scrape LinkedIn hoặc nhóm kín: **không bao giờ**.
- Cơ sở dữ liệu buyer độc quyền của ABCRM (cân nhắc sau: "buyer graph" ẩn danh hoá giữa tenant **không** làm trong MVP vì xung đột với cam kết tách biệt dữ liệu).
- EU/UK/Canada.

## 13. Giả định
- A1: Tenant có 2–20 người làm BD; mỗi tenant tiếp cận 500–5.000 buyer tiềm năng mỗi tháng.
- A2: ABCRM cung cấp contact data (D21); tenant vẫn có thể import file của họ (miễn phí Contact Credit).
- A3: Thị trường buyer ở US cho 5 vertical có vài nghìn đến vài chục nghìn công ty, đủ cho nhiều tenant nhưng các tenant **sẽ tiếp cận trùng buyer**. Đây là rủi ro uy tín chung (R3).

## 14. Câu hỏi mở
Đã chốt toàn bộ câu hỏi: Q7 (D18), Q11 (D19), Q12 (D20), Q13 (D21), Q14 (D22), Q15 (D23), Q16 (D24), Q17 (D25), Q18 (D26).
Câu hỏi tiếp theo sẽ đến từ phỏng vấn design partner, golden set và các spike (xem Roadmap). Riêng D27 cần xác minh qua phỏng vấn: **buyer thực sự đăng nhu cầu tìm publisher ở kênh nào** (LinkedIn, Telegram, Skype/Teams, Facebook groups, forum, Reddit, X)? Câu trả lời quyết định thứ tự làm source adapter.

## 15. Rủi ro
| # | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| R1 | Sourcing chất lượng thấp (sai buyer, dữ liệu cũ) làm rep mất niềm tin | Cao | Evidence bắt buộc, preview playbook trên mẫu, calibration, đo precision theo tier |
| R2 | Hallucination trong scorecard (bằng chứng bịa) | Cao | Trích dẫn phải khớp evidence đã lưu (kiểm tra bằng code); unknown là trạng thái hợp lệ; rep thấy nguồn trong card |
| R3 | **Nhiều tenant cùng spam một nhóm buyer**, khiến buyer chặn domain và ghét "offshore outreach" | Cao | Giới hạn tần suất **toàn cục** theo domain người nhận (đếm ẩn danh, không lộ tenant nào); chất lượng nội dung; AUP |
| R4 | Deliverability | Cao | Mailbox riêng tenant, send guard, auto-pause (ADR-012) |
| R5 | Crawl vi phạm ToS hoặc bị chặn | TB | Crawler lịch sự, ưu tiên search API và provider, không vượt rào cản |
| R6 | Chi phí LLM cho research cao | TB | Budget theo run, rule criteria trước, ai_judged sau (dừng sớm khi knockout fail), tier small/medium, cache trang theo domain |
| R7 | Solo founder quá tải | Cao | MVP hẹp: Sourcing, Qualify, G-Q, Outreach, Reply, Pipeline |
| R8 | **Chi phí và độ phủ contact data** (D21): chức danh như affiliate/partnerships manager ở lead buyer là ngách, provider có thể phủ thấp; giá mỗi contact có thể cao hơn giá bán | Cao | Waterfall nhiều provider, chỉ tính khi có kết quả verified, Contact Credit có giá riêng, đo độ phủ trên golden set trước khi ký hợp đồng |
| R9 | **Pháp lý data broker và license dữ liệu** | Cao | Luật sư review trước launch; chọn provider có license embedded/resale; global data suppression; lưu nguồn từng contact |
| R10 | **Intent signals bị "tranh nhau"**: một bài đăng công khai thu hút nhiều agency cùng email cho người đăng | Cao | Global contact pressure (D23) và giới hạn riêng theo tín hiệu: domain chỉ nhận tối đa N cold email liên quan đến tín hiệu trong 48h; nội dung chất lượng nhắc đúng nhu cầu |
| R11 | **Phân loại sai** (publisher tìm buyer bị nhầm là buyer) thì đi chào hàng cho đối thủ | TB | Eval riêng cho classifier; card hiển thị đoạn trích gốc; rep là người duyệt cuối (G-Q) |
| R12 | **Độ phủ thấp** do không đọc LinkedIn trực tiếp | TB | Kết hợp nhiều nguồn và manual capture; đo trong phỏng vấn kênh nào thật sự có tín hiệu |
