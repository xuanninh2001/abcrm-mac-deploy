# ABCRM — Vertical Packs (thị trường lead buyer tại US)

> Từ v0.4, **Vertical Pack** mô tả **thị trường người mua lead** trong từng ngành, để agent tìm, qualify và tiếp cận buyer đúng cách.
> Mỗi pack gồm: phân loại lead type, loại buyer, tín hiệu nhận diện, **IPP template**, **Playbook template**, query templates cho sourcing, góc tiếp cận khi viết email, và các yêu cầu compliance mà **buyer thường hỏi publisher**.
> Thông tin pháp lý chỉ để định hướng nội dung và tiêu chí; không phải tư vấn pháp lý.

## 1. Cấu trúc pack
```yaml
key: insurance
version: 1
lead_types: [medicare, aca_health, final_expense, life, auto, home, commercial]
purchase_formats: [data_lead, live_transfer, inbound_call, appointment]
buyer_types: [carrier, agency_or_call_center, aggregator, affiliate_network, ping_post_exchange]
contact_titles: ["Affiliate Manager", "Partnerships", "Director of Media Buying", "Head of Acquisition", "VP Marketing", "Founder"]
signals:
  web_paths: ["/partners", "/publishers", "/affiliates", "/become-a-partner", "/careers"]
  tech: [trustedform, jornaya, everflow, cake, tune, leadspedia, boberdoo, ringba, retreaver]
  text: ["publisher", "lead vendor", "live transfer", "pay per call", "accepting new partners"]
query_templates:
  - '"{lead_type}" "live transfers" "publishers"'
  - '"become a lead vendor" {lead_type}'
  - '"affiliate manager" "{lead_type} leads" jobs'
ipp_templates: [...]
playbook_templates: [...]
messaging:
  angles: ["compliant call-center capacity in US hours", "TrustedForm on every lead", "test with small cap"]
  avoid: ["guaranteed conversions", "cheapest leads", "unlimited volume"]
buyer_compliance_questions:   # buyer hay hỏi; Supply Profile cần trả lời sẵn
  - "Do you provide TrustedForm/Jornaya certificates?"
  - "Is consent language naming us as a seller?"
  - "Do you scrub against DNC?"
evals: evals/insurance
```

## 2. Năm vertical

### 2.1 Insurance
| Mục | Nội dung |
|---|---|
| Lead types | Medicare (đặc biệt mùa AEP/OEP), ACA/health, final expense, life, auto, home, commercial |
| Buyer types | Carrier, agency/call center lớn (FMO/IMO), aggregator, affiliate network, ping-post exchange |
| Tín hiệu mạnh | Trang "publishers/lead vendors", script TrustedForm/Jornaya trên form, tuyển "affiliate manager" hoặc "licensed agents" số lượng lớn |
| Tiêu chí gợi ý | Mua đúng lead type và hình thức; chấp nhận call center ngoài US (nhiều buyer Medicare **không** chấp nhận, nên cần knockout hoặc unknown để rep kiểm tra); có yêu cầu consent rõ ràng; tính mùa vụ (AEP) |
| Buyer thường hỏi | Consent và certificate, kịch bản gọi, ghi âm, license của agent nhận transfer (phía buyer), quy định riêng về marketing Medicare |
| Lưu ý | Quy định marketing Medicare (CMS) khắt khe; nhiều buyer giới hạn nguồn traffic; nội dung email không nói thay buyer về sản phẩm bảo hiểm |

### 2.2 Finance
| Mục | Nội dung |
|---|---|
| Lead types | Debt relief/settlement, personal loans, tax relief, credit repair, mortgage/refi, business funding (MCA/SBA) |
| Buyer types | Lender, debt settlement company, tax resolution firm, aggregator/marketplace, affiliate network |
| Tín hiệu | Trang "partner program/affiliate program", tech tracking, giấy phép/đăng ký công khai (tuỳ loại) |
| Tiêu chí gợi ý | Lead type khớp; yêu cầu tối thiểu (ví dụ unsecured debt ≥ ngưỡng); hình thức (live transfer phổ biến cho debt/tax); uy tín thanh toán |
| Buyer thường hỏi | Consent, DNC scrub, script tuân thủ telemarketing (debt relief có quy định riêng của FTC), không hứa hẹn kết quả |
| Lưu ý | Ngành có nhiều buyer rủi ro về thanh toán và uy tín, nên **Buyer Due Diligence (D1)** quan trọng; khuyến nghị payment terms prepay/net ngắn cho buyer mới |

### 2.3 Legal
| Mục | Nội dung |
|---|---|
| Lead types | Motor vehicle accident (MVA)/personal injury, mass tort (theo từng tort), workers' comp, SSDI, employment, immigration |
| Buyer types | Law firm, legal marketing agency, intake/case acquisition company, aggregator, affiliate network |
| Tín hiệu | Đang chạy mass tort campaign, trang "co-counsel/referral partners", tech tracking, tuyển "intake specialists" |
| Hình thức | Data lead, live transfer, **signed retainer** (giá cao) |
| Tiêu chí gợi ý | Tort/case type khớp; bang hoạt động; tiêu chí intake (ngày sự cố, có đại diện pháp lý chưa…); chấp nhận nguồn offshore intake |
| Buyer thường hỏi | Consent, recording, quy trình intake, tuân thủ quy tắc quảng cáo luật sư của từng bang |
| Lưu ý | Quy tắc đạo đức nghề luật (attorney advertising, chia phí giới thiệu) khác nhau theo bang; nội dung email không đưa lời khuyên pháp lý và không hứa bồi thường |

### 2.4 Home Services
| Mục | Nội dung |
|---|---|
| Lead types | Solar, roofing, HVAC, windows/doors, bath/kitchen remodel, home warranty, pest control, gutters, walk-in tubs |
| Buyer types | Nhà thầu/brand quốc gia, dealer network, aggregator/marketplace, call center bán appointment |
| Tín hiệu | Trang "dealer/partner program", tech tracking, chạy quảng cáo nhiều bang, tuyển "appointment setters" |
| Hình thức | Data lead, live transfer, **appointment** (đặt lịch cho thợ) |
| Tiêu chí gợi ý | Service area (bang/ZIP); homeowner-only; khung giờ nhận; chấp nhận appointment set từ call center offshore |
| Buyer thường hỏi | Consent, tỉ lệ show-up của appointment, cách verify homeowner |

### 2.5 Education
| Mục | Nội dung |
|---|---|
| Lead types | Online degree (higher-ed), trade/vocational school, bootcamp, certificate, continuing education |
| Buyer types | Trường/OPM (online program manager), education marketing agency, aggregator (lead marketplace), affiliate network |
| Tín hiệu | Trang "publisher/partner program", tech tracking, chạy campaign tuyển sinh theo mùa |
| Hình thức | Data lead (inquiry), live transfer tới admissions, inbound call |
| Tiêu chí gợi ý | Chương trình và tiêu chí học viên (độ tuổi, trình độ, bang); quy định của buyer về nguồn traffic; mùa tuyển sinh |
| Buyer thường hỏi | Consent, nguồn traffic (nhiều buyer cấm incentivized traffic), tuân thủ quy định về tuyển sinh |
| Lưu ý | Trường nhận hỗ trợ tài chính liên bang có quy định nghiêm về tuyển sinh và hoa hồng; email không hứa kết quả việc làm |

## 3. Data lead buyers: điểm chung (D19)
Tenant đầu tiên bán **data lead (CPL)**, nên mọi pack ưu tiên buyer mua data lead. Thông tin cần thu thập về buyer (qua sourcing, discovery call, hoặc posting spec công khai):

| Thuộc tính | Vì sao quan trọng | Nơi thường tìm thấy |
|---|---|---|
| Cách nhận lead: **ping-post**, **direct post** (API), batch/CSV | Quyết định yêu cầu kỹ thuật và giá | Trang publisher, posting spec/API docs, ping-post platform đang dùng |
| Ping-post/distribution platform (LeadsPedia, boberdoo…) | Tín hiệu buyer mua lead từ nhiều publisher | Tech signals, posting URL |
| Required fields và filters (bang, độ tuổi, loại bảo hiểm, loại dự án…) | Supply của agency có khớp không | Posting spec |
| Exclusive vs shared | Ảnh hưởng giá | Trang publisher, discovery |
| Khoảng CPL, cap ngày | Đánh giá giá trị | Discovery (hiếm khi công khai) |
| **Yêu cầu consent**: TrustedForm/Jornaya trên mỗi lead, consent language nêu tên buyer | Buyer data lead gần như luôn yêu cầu | Posting spec, trang compliance |
| Return policy (lý do, thời hạn) | Rủi ro doanh thu | Discovery, IO |
| Payment terms (prepay, net 7/15/30) | Rủi ro thanh toán (agency offshore đặc biệt quan tâm) | Discovery, D1 due diligence |

## 4. Template tiêu chí dùng chung (mọi vertical)
| Tiêu chí | Kind | Evaluation | Gợi ý nguồn |
|---|---|---|---|
| Hoạt động tại US | knockout | rule | Địa chỉ, bang |
| Không phải đối thủ trực tiếp (bán cùng loại lead) | knockout | ai_judged | Homepage, "about" |
| Không nằm trong blocklist / không phải partner hiện tại | knockout | rule | CRM |
| Mua lead type khớp Supply Profile | must_have | ai_judged | Partners page, job posts, case studies |
| **Mua data lead (CPL)** từ publisher bên ngoài (ping-post / direct post) | must_have | ai_judged + rule (tech signal) | Posting spec, publisher page, ping-post platform |
| Chấp nhận consent certificate mà agency cung cấp (TrustedForm/Jornaya) | scored | ai_judged | Compliance/publisher page |
| Có bằng chứng mua từ publisher bên ngoài | must_have | ai_judged | Partners/publishers page, tech signals |
| Hình thức mua khớp (data/LT/PPC/appointment) | scored | ai_judged | Partners page |
| Chấp nhận publisher/call center ngoài US | scored | ai_judged (thường unknown) | Partners page, job posts |
| Dùng tracking platform chuẩn ngành | scored | rule (tech signals) | HTML |
| Đang tuyển affiliate/media/intake | scored | ai_judged | Careers, job boards |
| Quy mô phù hợp (nhân sự, số bang) | scored | rule | Provider/enrichment |
| Tín hiệu uy tín thanh toán (không có phản hồi xấu công khai) | scored | ai_judged (D1) | Nguồn công khai do tenant cấu hình |
| Tuổi công ty ≥ N năm | scored | rule | Provider, WHOIS/đăng ký |

## 5. Signal templates (D27)
Mỗi pack có sẵn bộ từ khoá cho **Signal Monitor**. Tenant clone rồi chỉnh.

| Vertical | Cụm từ intent (ví dụ) | Chức danh trong tin tuyển dụng |
|---|---|---|
| Insurance | "looking for publishers" + ACA/Medicare/final expense/auto insurance; "lead vendors wanted"; "need data leads" + insurance; "TrustedForm required" + publishers | Affiliate Manager (Insurance), Lead Vendor Manager, Publisher Development, Media Buyer |
| Finance | "seeking affiliates" + debt relief/personal loans/tax relief; "need publishers" + debt; "lead providers wanted" + loans | Affiliate Partnerships Manager, Performance Partnerships, Lead Acquisition Manager |
| Home Services | "looking for lead vendors" + solar/roofing/HVAC/remodel; "need exclusive leads" + solar; "publishers wanted" + home improvement | Lead Acquisition, Partner Marketing Manager, Dealer Network |
| Education | "seeking publishers" + education/online degree/enrollment; "need inquiry leads" | Affiliate/Publisher Manager (EDU), Enrollment Marketing |
| Legal | "need case leads" + MVA/mass tort; "looking for intake partners" | Case Acquisition Manager, Legal Marketing Partnerships |

**Từ khoá loại trừ mặc định** (giảm nhiễu): "I'm a publisher", "we provide leads", "selling leads", "job seeker", "open to work".
**Ca khó cho classifier**: agency hoặc network vừa mua vừa bán lead; bài đăng "we have traffic, looking for offers" là **publisher tìm buyer**, tức đối thủ của tenant.

## 6. Cách pack được dùng
1. **IPP**: tạo nhanh từ `ipp_templates`; tenant chỉnh sửa.
2. **Sourcing**: `query_templates` và `signals` giúp S1 lập kế hoạch; tech detector dùng danh sách `tech`.
3. **Qualification**: `playbook_templates` là điểm khởi đầu; tenant tuỳ chỉnh (D15).
4. **Outreach**: `messaging.angles/avoid`; W1 lấy câu trả lời cho `buyer_compliance_questions` từ Supply Profile.
5. **Evals**: dataset trang web mẫu (gồm trang giả và trang chứa injection), scorecard kỳ vọng, email mẫu.

## 7. Thứ tự làm pack & câu hỏi mở
- **Đã chốt (D24):** làm **Insurance**, **Finance**, **Home Services** trước (Phase 1); **Education** sau (Phase 2); **Legal** sau cùng (Phase 3, vì nghiêng về live transfer/signed case nhiều hơn data lead).
- Với Finance, ưu tiên các lead type có thị trường data lead lớn: debt relief, personal loans, tax relief; Due Diligence (D1) quan trọng vì rủi ro thanh toán cao hơn.
- Có nguồn công khai nào về uy tín thanh toán của buyer mà tenant tin dùng (diễn đàn, cộng đồng affiliate)?
