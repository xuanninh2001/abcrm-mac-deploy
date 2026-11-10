# ABCRM — Roadmap (v0.7: Partner acquisition cho offshore data-lead agency)

> 1 founder full-time, dùng mạnh AI coding agent; buy-not-build. Thời gian là ước lượng; không sang phase sau khi chưa đạt exit criteria.

## Nguyên tắc
1. **Giá trị đầu tiên là danh sách buyer data lead đã qualify, có contact verified, mà rep tin dùng.**
2. **Concierge trước khi tự động hoá**: founder tự chạy sourcing cho design partners ở Phase 1 để hiệu chỉnh playbook.
3. **Một cell US**, một ngôn ngữ code, một database.
4. **Design partners**: 3–5 agency offshore bán data lead, đang dùng **RedTrack**, vertical Insurance, Finance và Home Services (D24).
5. **Thủ tục có thời gian chờ bắt đầu từ tuần 1**:
   - Google OAuth verification, Microsoft publisher verification.
   - Stripe SG.
   - **Hợp đồng license với contact data provider** (cần điều khoản resale/embedded).
   - Luật sư: CAN-SPAM, CCPA, **data broker**, crawl, DPA PDPA.

> Đặc tả chi tiết Phase 0–1: [`specs/phase-0-1/`](./specs/phase-0-1/README.md)

## Phase 0: Foundation (tuần 1–5)
- Monorepo, CI/CD, Render và Neon (staging, prod-us), DBOS spike.
- `iam` (WorkOS, roles, múi giờ làm việc), RLS và cross-tenant test, field encryption, audit, outbox.
- `pipeline` tối thiểu; import CSV/Excel; blocklist, đối thủ, buyer hiện có.
- `supply`: Supply Profile (mặc định data lead: cách giao, posting capability, consent assets).
- **Đánh giá 3–5 contact data provider** trên golden set (độ phủ title affiliate/partnerships tại lead buyer, độ chính xác email, giá, license) rồi chọn 2–3 cho waterfall.
- Nộp Google OAuth verification.

**Exit:** chọn xong provider và ký license; RLS test xanh; import 10k account.

## Phase 1: Sourcing + Contact Data + Qualification + Approve-to-Contact (tuần 6–13)
- `sourcing`: IPP builder (template data-lead buyer), sourcing run có budget, search adapter, fetcher và public page cache, extractor, tech signals (ping-post platforms, TrustedForm/Jornaya), dedupe, evidence.
- `contactdata`: waterfall, license policy, licensed cache (nếu được phép), email verification, **global data suppression**, internal cost ledger.
- `qualification`: Playbook builder, preview, engine có quote verification, scorecard, tier.
- `decisions`: Decision Inbox, Approve-to-Contact card, grouped review, reject reasons, SLA theo giờ làm việc của rep.
- Agent platform: tool registry, policy invariants, LLM gateway, DBOS runtime, metering hai meter (nội bộ).
- Templates **S1, S2, Q1, W1**.
- Vertical packs **Insurance**, **Finance**, **Home Services** v1 (D24). Để giảm tải, làm Insurance đầy đủ trước, sau đó clone cấu trúc cho Finance và Home Services.

**Exit (3 design partners):** mỗi tenant ≥ 300 card; precision Tier A ≥ 70%; độ phủ contact verified ≥ 60% trên account Tier A/B; chi phí/contact và chi phí/card trong mục tiêu unit economics.

## Phase 2: Outreach + Pipeline + RedTrack + Billing (tuần 14–22)
- `outreach`: mailbox Gmail/M365, domain check, ramp, sequence (follow-up deterministic được coi là đã duyệt, D18), send scheduler theo giờ người nhận, send guard (gồm global contact pressure), reply sync, unified inbox, unsubscribe/bounce, auto-pause.
- Templates **R1, M1, B1, D1, K1**; manual-channel drafts (LinkedIn/Telegram).
- Partnership terms (posting method, CPL, cap, return policy, payment terms); onboarding checklist.
- **Intent Signals v1** (D27, ADR-016): Signal Monitors, adapters `search_index`, `jobs`, `offer_dirs`, `reddit`, `manual` (paste, forward email, nút Save khi rep bấm); classifier có eval (precision `buyer_seeking_supply` ≥ 90% mới bật fast-track); fast-track sang qualification; làn `hot-intent`; giới hạn tần suất theo tín hiệu. Template **L1 Intent Listener**.
- **RedTrack integration** (read-only): mapping buyer ↔ offer source/offer, daily sync, báo cáo doanh thu theo buyer, P1 cảnh báo.
- `billing`: Stripe (SG), seat và hai meter, Stripe Tax, usage dashboard, budget theo run, spend cap, credit packs, trial.
- Vertical pack **Education** v1 (D24); UI tiếng Việt (tuỳ chọn); import HubSpot.

**Exit:** 10+ tenant trả tiền; ≥ 1 buyer mới ký mỗi tenant/tháng; doanh thu buyer mới đo được qua RedTrack; gross margin ≥ 65% (tính cả contact data).

## Phase 3: Scale (tháng 6–9)
- Calibration dùng doanh thu RedTrack làm nhãn; công nợ và cảnh báo chậm trả.
- Vertical pack **Legal**.
- Signal sources mở rộng: X API, Telegram public channels (nếu phỏng vấn xác nhận buyer đăng ở đó).
- Import Salesforce, Lark; Copilot; Slack/Telegram notifications; SSO; SOC 2 Type I; pentest.
- Tracking platform thứ hai (Everflow/LeadsPedia) nếu có nhu cầu.

## Phase 4: Expand
- Thị trường buyer ngoài US; EU cell.
- Agent Builder tự do; MCP server.
- Chiều ngược lại: tìm **publisher/traffic source** cho agency mua traffic.

## Việc cần làm ngay (2 tuần tới)
1. Mọi câu hỏi sản phẩm đã chốt (D18–D26); câu hỏi mới sẽ đến từ phỏng vấn và spike.
2. **Phỏng vấn thêm về intent (D27)**: "Lần gần nhất anh/chị tìm được buyer qua một bài đăng là ở kênh nào?" (LinkedIn, Telegram, Skype/Teams, Facebook group, forum, Reddit, X). Thu thập 30–50 bài đăng thật (ẩn danh) để làm eval cho classifier.
3. **Golden set**: 200 buyer data lead thật (Insurance, Finance, Home Services) có nhãn phù hợp/không phù hợp, kèm 2–3 người liên hệ đúng tại mỗi buyer (nếu design partner biết). Dùng để đo sourcing, qualification và **độ phủ contact data**.
4. **Đánh giá contact data provider**: độ phủ, độ chính xác, giá theo volume, **điều khoản resale/embedded, cache, lưu trữ**; ưu tiên provider có API waterfall-friendly.
5. **RedTrack**: lấy một tài khoản mẫu (read-only) từ design partner để xác nhận API báo cáo theo **Offer Source** (D25), rate limit và phân quyền API key.
6. Luật sư (thêm: dùng snippet từ search API về bài đăng mạng xã hội; lưu dữ liệu tác giả bài đăng): nghĩa vụ data broker khi ABCRM cung cấp contact data; CAN-SPAM cho người gửi offshore; DPA.
7. Spikes (thêm: chất lượng search API cho truy vấn intent có giới hạn thời gian; job postings API): search provider, fetcher/extractor, qualification precision, DBOS approval wait.
