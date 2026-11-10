# Phase 0–1 Specification: Foundation + Sourcing + Contact Data + Qualification + Approve-to-Contact

| Mục | Giá trị |
|---|---|
| Spec version | 0.1 (2026-10-25) |
| Dựa trên | PRD v0.8, System Design v0.7, Roadmap v0.7, ADR-001…016 |
| Thời gian | Phase 0: tuần 1–5 · Phase 1: tuần 6–13 |
| Người thực hiện | Solo founder và AI coding agent |

## 1. Bộ tài liệu
| File | Nội dung |
|---|---|
| [`schema.sql`](./schema.sql) | DDL PostgreSQL ban đầu của spec. **Từ khi scaffold, nguồn sự thật là [`packages/db/migrations`](../../../packages/db/migrations)** (0001 = file này; 0002 roles/grants/auth resolvers; 0003 partitions; 0004 outbox dispatch) |
| [`rls_smoke_test.sql`](./rls_smoke_test.sql) | Test nhanh RLS và tính bất biến (đã chạy thử trên PG16) |
| [`events.md`](./events.md) | Event catalog (outbox topics, payload, consumer) |
| [`tools.md`](./tools.md) | Tool catalog v1 (schema, side effect, gate, permission, credits) |
| [`api.md`](./api.md) | REST API cho UI và public API Phase 0–1 |
| [`agents.md`](./agents.md) | Đặc tả agent S1, S2, Q1, W1: input/output, prompt structure, limits, evals |
| [`ipp-playbook-format.md`](./ipp-playbook-format.md) | Định dạng IPP, Playbook, Supply Profile; quy tắc tính điểm |
| [`vertical-packs/insurance.yaml`](./vertical-packs/insurance.yaml) | Insurance pack v1 (mẫu đầy đủ; Finance và Home Services clone cấu trúc này) |
| [`decision-inbox.md`](./decision-inbox.md) | UX và state machine của Decision Inbox, Approve-to-Contact card |
| [`exit-criteria-review.md`](./exit-criteria-review.md) | Rà soát exit criteria Phase 0–1 (M6): trạng thái, bằng chứng, việc còn lại |
| [`test-plan.md`](./test-plan.md) | Test plan: isolation, invariants, metering, evals, golden set, acceptance |

## 2. Phạm vi

### Trong phạm vi
- **Platform**: monorepo, CI/CD, staging và prod-us; WorkOS auth; tenant, users (roles, timezone, working hours), service personas, API keys; RLS; field encryption và blind index; outbox; audit log hash chain; DBOS runtime.
- **CRM tối thiểu**: accounts, contacts, opportunities, activities; suppression/blocklist; flags (competitor, existing_buyer, do_not_contact).
- **Import**: CSV/XLSX cho accounts, contacts, blocklist, existing buyers, sourcing candidates (staging, mapping, AI mapping I1, dry-run, commit, rollback).
- **Supply Profile, IPP, Playbook** (có version và approval G-T1).
- **Sourcing**: sourcing run có budget, search adapter (1 provider), fetcher lịch sự, public page cache, extractor, tech signals, dedupe, evidence.
- **Contact Data Layer**: waterfall 2–3 provider, license policy, licensed cache, email verification, global data suppression, pay-on-result.
- **Qualification**: engine rule + ai_judged, quote verification, scorecard, tier; preview playbook.
- **Decision Inbox**: G-T1 (setup), G-Q card (kèm email draft từ W1), grouped review, reject reasons, SLA theo giờ làm việc.
- **Agent platform**: tool registry, policy engine (invariants), LLM gateway, runtime, templates S1, S2, Q1, W1, I1, metering nội bộ (Agent và Contact meters, chưa tính tiền qua Stripe), guardrails theo agent.
- **Vertical packs**: Insurance (đầy đủ), Finance, Home Services (clone cấu trúc).

### Ngoài phạm vi (Phase 2+)
Gửi email (mailbox, sequence, send guard), reply handling, Intent Signals, RedTrack, Stripe billing, HubSpot/Salesforce/Lark import, Copilot, Slack/Telegram, UI tiếng Việt.

> Card G-Q ở Phase 1 duyệt **quyền liên hệ và nội dung email đầu tiên**; email được lưu ở trạng thái `approved` (`email_drafts.status`) để Phase 2 gửi. Design partner có thể **export** danh sách đã duyệt (CSV) để tự gửi bằng công cụ hiện tại trong giai đoạn chuyển tiếp.

## 3. Milestones

| # | Tuần | Milestone | Demo / bằng chứng |
|---|---|---|---|
| M0 | 1 | Repo, CI, staging deploy; Google OAuth verification đã nộp; thư gửi data provider | CI xanh, URL staging |
| M1 | 2–3 | IAM, tenant, RLS, encryption, audit, outbox, DBOS hello-workflow (approval wait, restart) | `rls_smoke_test` và cross-tenant suite xanh; video restart worker |
| M2 | 4–5 | CRM tối thiểu, import CSV (mapping, dry-run, rollback), Supply Profile; **chọn và ký 2–3 provider** | Import 10k account; rollback; báo cáo đánh giá provider |
| M3 | 6–8 | IPP và Playbook builder, G-T1, sourcing engine (search, fetch, cache, extract, tech signals), evidence | Sourcing run 200 candidate trên Insurance |
| M4 | 8–10 | Contact Data Layer, qualification engine, quote verification, scorecard, preview | Precision trên golden set (lần 1) |
| M5 | 10–12 | Decision Inbox, G-Q card, W1 draft, grouped review, metering nội bộ, guardrails | 3 design partner duyệt card thật |
| M6 | 12–13 | Finance và Home Services packs, hardening, eval CI, runbooks | Exit criteria Phase 1 |

## 4. Exit criteria
**Phase 0**
- [ ] Cross-tenant test suite xanh cho 100% endpoint (xem test-plan §2).
- [ ] Import 10k account, rollback thành công.
- [ ] Đã ký license với ≥ 2 contact data provider có điều khoản resale/embedded.
- [ ] Deploy một lệnh; PITR được kiểm tra (restore staging).

**Phase 1** (3 design partners)
- [ ] Mỗi tenant có ≥ 300 card G-Q.
- [ ] Precision Tier A ≥ 70% (tỉ lệ card Tier A được rep duyệt).
- [ ] 0 quote không kiểm chứng trên card (kiểm toán tự động).
- [ ] Độ phủ contact verified ≥ 60% trên account Tier A/B.
- [ ] Chi phí biến đổi: ≤ $0,0024/Agent Credit và ≤ $0,10/Contact Credit (đo từ `cost_ledger`).
- [ ] Không có đường nào tạo `email_drafts.status='approved'` mà thiếu decision G-Q `approved` (property test và kiểm toán DB).
- [ ] Rep duyệt một card trong < 30 giây trung vị.

## 5. Quy ước kỹ thuật chung
- **IDs**: UUIDv7 sinh ở app. **Time**: UTC; hiển thị theo `users.timezone`.
- **Transactions**: mọi request mở transaction, gọi `set_config('app.tenant_id', …, true)` trước query đầu tiên; repository nhận `TenantTx` (type-level).
- **Idempotency**: API ghi nhận header `Idempotency-Key`; workflow step có key `run:step`.
- **Events**: ghi `outbox` trong cùng transaction với thay đổi; payload chỉ có ID.
- **Errors**: RFC 9457 (`application/problem+json`) với `type` ổn định (xem api.md §1).
- **Feature flags**: bảng `tenants.settings.flags` cùng PostHog cho rollout.
- **Logging**: không log PII; dùng `redact()` trước khi ghi trace (Langfuse).

## 6. Ghi chú triển khai (scaffold Phase 0)
Các điểm phát hiện khi viết code và test, đã cập nhật vào migrations:
- **Partition và RLS**: RLS chỉ áp dụng khi truy cập qua bảng cha. App role bị thu hồi mọi quyền trên partition (0003), và `checkRlsCoverage` fail nếu app truy cập được partition.
- **Trigger dùng `search_path` cố định** (`criteria_immutable`), nếu không trigger lỗi khi app kết nối với `search_path` mặc định.
- **Audit chain**: `at` tăng nghiêm ngặt theo tenant (µs) và được hash ở dạng text UTC, để thứ tự verify trùng với thứ tự ghi, kể cả khi nhiều entry ghi trong cùng một ms.
- **Outbox dispatch xuyên tenant** qua hai hàm SECURITY DEFINER `claim_outbox` (lease, `SKIP LOCKED`) và `mark_outbox_dispatched`. Mỗi event chạy trong một DBOS workflow có ID `evt:<id>`, nên gửi lại là vô hại.
- **Workflow chờ decision**: khi hết hạn chờ, workflow đọc trạng thái thật trong DB, không mặc định là expired.
- **Auth (M1)**: API nhận WorkOS AuthKit access token (JWT RS256, verify bằng JWKS của WorkOS), danh tính là `(org_id, sub)`, tra qua `resolve_workos_identity`; role luôn lấy từ DB. Session cookie và luồng đăng nhập thuộc về Next.js app (M5). Tự động tạo user khi đăng nhập lần đầu (qua webhook WorkOS) để sau.
- **KMS (M1)**: `AwsKmsKeyProvider` bọc data key của tenant với `EncryptionContext = {abcrm: "tenant:<id>:<purpose>"}`; app từ chối khởi động ở production nếu thiếu `ABCRM_KMS_KEY_ID` hoặc `WORKOS_CLIENT_ID` (worker chưa dùng khoá; sẽ thêm cùng kiểm tra khi có).

### Trạng thái M1
- [x] IAM, tenant, RLS, encryption, audit, outbox, DBOS (approval wait, restart). Test và CI xanh.
- [x] WorkOS access token auth; AWS KMS key provider.
- [ ] Việc ngoài code (founder): tạo WorkOS project và organization; tạo KMS key cho `us`; nộp Google OAuth verification; kiểm tra PITR restore trên Neon staging.

### Trạng thái M2
- [x] CRM tối thiểu: account (PATCH với allowlist cột, flags), contact (PII mã hoá, dedupe email, tự đánh dấu suppressed), opportunity, activity; field history qua `record_changes`.
- [x] Suppression theo tenant: email/domain, giá trị lưu mã hoá để hiển thị (`value_enc`, migration 0005); không gỡ được mục mang nghĩa vụ pháp lý (unsubscribe, complaint, DSAR); gỡ cần `compliance.manage` (owner/admin).
- [x] Supply Profile: draft → submit (G-T1, làn `setup`) → approve kích hoạt version mới và archive version cũ; reject trả về draft. Duyệt và thực thi trong một transaction qua `EXECUTORS`.
- [x] Import CSV/XLSX: accounts, contacts, blocklist, existing_buyers. Có mapping theo từ đồng nghĩa (người dùng duyệt), dry-run từng dòng, commit idempotent (khớp bản ghi có sẵn, không tạo trùng), rollback chỉ xoá bản ghi job tạo ra và chưa bị sửa.
- [x] Test fuzz truy cập chéo tenant phủ mọi route `GET/PATCH/POST/PUT/DELETE /:id` của 6 nhóm resource.
- [ ] Việc ngoài code (founder): đánh giá và ký license 2–3 contact data provider.

Khác biệt so với spec, đã ghi lại:
- **Import ≤ 100k dòng/file, xử lý đồng bộ.** Streaming cho file lớn (spec: 1M dòng) để milestone sau.
- **Mapping theo từ đồng nghĩa.** Agent I1 (AI mapper) làm ở Phase 1.
- **Dữ liệu staging (`raw`) lưu dạng rõ** như spec cho phép. Job xoá sau 30 ngày chưa viết.
- **Approve decision cần `content_hash`** (hex) của bản người duyệt đã xem; hash lệch thì trả 412.

### Trạng thái M3
- [x] **Playbook builder:** criteria validate theo §4 (rule JSONLogic dùng allowlist biến; trọng số chỉ cho tiêu chí scored; ngưỡng A > B > C), có version theo lineage, chạy G-T1, criteria của bản active không sửa được.
- [x] **IPP:** có version, chạy G-T1; chỉ submit được khi playbook đang active; domain loại trừ được chuẩn hoá.
- [x] **Vertical pack Insurance:** thêm `criteria_library` (định nghĩa đầy đủ từng tiêu chí). Bản runtime (`packages/setup/packs/insurance.yaml`) và bản trong spec được test giữ giống hệt nhau. Clone pack tạo bản nháp Playbook và IPP.
- [x] **Fetcher:**
  - Chặn SSRF ngay lúc mở kết nối (chống DNS rebinding), chặn IP literal, IPv4-mapped IPv6, metadata endpoint.
  - No-crawl list (LinkedIn, Facebook); robots.txt theo RFC 9309 (4xx thì cho phép, 5xx thì chặn hết).
  - Giành lượt theo domain cho toàn hệ thống; tối đa 3 redirect, mỗi hop kiểm lại; giới hạn 5 MB và 15 giây; chỉ nhận HTML hoặc text.
  - Cache trang công khai TTL 7 ngày.
- [x] **Sourcing engine:**
  - Lập query bằng template từ pack và IPP; search adapter (Brave) có cache.
  - Đọc trang chủ và tối đa 3 trang tín hiệu; bằng chứng là câu nguyên văn từ trang.
  - Tech signals: TrustedForm, Jornaya, LeadsPedia, boberdoo…
  - Dedupe: account đã có, flag, domain bị suppress, liên hệ trong 90 ngày, domain loại trừ.
  - Ghi credit `candidate_sourced` (idempotent); ngân sách tính theo run.
  - Chạy lại sau crash không tạo trùng candidate, không tính credit hai lần.
- [x] **Worker:** event `sourcing.run.queued` khởi động DBOS workflow `sourcingRun`; chưa có search provider thì run `failed` kèm lý do rõ.
- [x] **API:** `/vertical-packs`, `/playbooks`, `/ipps`, `/sourcing-runs` (estimate; run lớn hơn 500 candidate hoặc 5.000 credit phải qua G-T1; pause/resume/cancel; candidates), `/accounts/:id/evidence`.

Khác biệt so với spec, đã ghi lại:
- **Examine chưa dùng LLM.** Bước đọc trang dùng rule: cụm từ tích cực/tiêu cực của pack và tech signals. Phần trích xuất bằng LLM của S1 (`isLeadBuyerLikely`, `isCompetitorLikely`) thêm ở M4 cùng LLM gateway và Q1.
- **Playbook submit chưa bắt buộc preview** (§3.2), vì preview cần qualification engine (M4).
- **Search provider:** adapter Brave theo API công khai; việc chọn provider chờ spike. Chữ ký tech signals cần kiểm chứng trên site thật.
- **Nội dung trang lưu trong `public_pages.content_text`** (migration 0006). Chuyển sang object storage sau.
- **Workflow sourcing khởi động trực tiếp,** chưa qua DBOS queue có giới hạn concurrency theo tenant (làm cùng metering M5).
- **Credit chỉ được ghi lại** (`usage_events`), chưa reserve hay chặn theo số dư tenant (M5); chỉ ngân sách của run được áp dụng.

### Trạng thái M4
- [x] **LLM Gateway** (`packages/llm`, ADR-005):
  - Agent khai báo tier, gateway chọn model: `small` / `medium` / `large` map sang Haiku / Sonnet / Opus (bảng ở `packages/llm/src/pricing.ts`). Đổi được bằng `ABCRM_LLM_MODEL_<TIER>`.
  - Output luôn đi qua structured outputs (JSON schema từ Zod) và được validate lại bằng code. Model từ chối, output bị cắt hoặc sai schema đều thành `LlmOutputError` (kèm usage đã bị tính phí), không làm sập workflow.
  - Các lớp prompt ổn định đặt trước, cache breakpoint ở lớp cuối. Effort theo tier (low / medium / high).
  - Bật server-side refusal fallback (`fallbacks: "default"`) cho Sonnet và Opus.
  - Chi phí từng call ghi vào `cost_ledger` để theo dõi margin.
  - `ScriptedLlm` dùng cho test và chạy offline.
  - Nội dung web luôn nằm trong `<untrusted_data>`; thẻ đóng chèn trong nội dung bị vô hiệu hoá.
- [x] **S1 extractor:** sau bước examine bằng rule, một call `small` mỗi domain để trích `is_lead_buyer_likely`, `is_competitor_likely`, buyer type, lead types, HQ, quy mô và purchase signals.
  - Rule vẫn là sàn: "yes" chỉ được nhận khi có tín hiệu rule hoặc purchase signal đã kiểm chứng; "no" hoặc đối thủ thì bỏ qua domain.
  - Quote chỉ được giữ nếu có nguyên văn trong text trang.
  - Fact chỉ điền vào trường account đang trống.
  - Không có `ANTHROPIC_API_KEY` thì S1 chạy như M3.
- [x] **Q1 qualification engine** (`qualifyCandidate`):
  - Tiêu chí rule chấm bằng code trước. Tiêu chí AI theo lô ≤ 4, thứ tự knockout → must_have → scored; dừng sớm khi knockout hoặc must_have fail.
  - Mọi quote kiểm chứng substring với evidence. "pass" thiếu quote verified bị ép thành "unknown".
  - Tier tính bằng `finalizeScorecard`; LLM không đặt điểm.
  - Fetch bổ sung theo `hints` (≤ 4 trang, qua Fetcher lịch sự) và lưu các đoạn văn liên quan nhất thành evidence.
  - Summary (why fit / risks) chỉ tạo cho account đủ tier lên card.
  - Scorecard và criterion results bất biến; chạy lại trả về scorecard cũ (unique theo candidate + playbook, migration 0007).
  - Credit `scorecard_ai` = 4 hoặc `scorecard_rule_only` = 1. Có agent run, agent steps, chi phí LLM, cập nhật stats của run.
  - Kill switch và agent bị pause được kiểm tra trước khi chạy.
- [x] **Playbook preview:** `POST /playbooks/{id}/preview` → worker chấm playbook (kể cả bản nháp) trên ≤ 20 account gần nhất có evidence. Không ghi scorecard; kết quả từng account và phân bố tier lưu ở `playbook_previews`. Tính credit như scorecard.
- [x] **Contact Data Layer** (`packages/contactdata`, system design §5.7):
  - Kiểm global suppression theo domain → licensed cache dùng chung (mã hoá bằng platform key, không ghi tenant nào đã tra) → waterfall provider theo `data_providers.priority` và license (`resale_ok`, `cache_scope`, `ttl_days`) → match title theo từ đồng nghĩa của pack (exact / close / weak) → verify email → kiểm global suppression theo email và person key → kiểm suppression của tenant → ghi contact mã hoá.
  - Chỉ tính phí theo kết quả: valid = 1, catch-all = 0,5; contact tenant đã có thì không tính lại. Có giới hạn theo ngân sách contact của run.
  - Lookup idempotent theo id.
- [x] **Worker:**
  - `sourcing.candidate.ready` → workflow Q1 (`q1:<candidate>`).
  - `qualification.scorecard.created` đủ tier → S2 tìm contact khi account chưa đủ contact valid (`s2:<scorecard>`).
  - `contactdata.lookup.requested` → lookup thủ công.
  - `playbook.preview.requested` → preview.
- [x] **API:**
  - `POST /playbooks/{id}/preview` (202), `GET /playbooks/{id}/previews`, `GET /playbook-previews/{id}`.
  - `GET /accounts/{id}/scorecards`, `GET /scorecards/{id}`.
  - `POST /accounts/{id}/contacts/find` (202), `GET /contact-lookups/{id}`.
  - `POST /candidates/manual`.
  - Fuzz test chéo tenant phủ cả các route mới.
- [ ] Việc ngoài code (founder): ký hợp đồng contact data provider (chưa có adapter thật nào được bật), tạo `ANTHROPIC_API_KEY`, sinh platform keys (`ABCRM_PLATFORM_HMAC_KEY`, `ABCRM_PLATFORM_CACHE_KEY`) trong secrets manager, dựng golden set Insurance để đo precision lần đầu.

Khác biệt so với spec, đã ghi lại:
- **Chưa có adapter contact provider thật.** Interface `ContactProvider` / `EmailVerifier` đã sẵn; vendor được bật khi có hợp đồng (row `data_providers` cộng adapter). Không có verifier thì tin trạng thái email của provider. Match title dùng rule; LLM cho ca mơ hồ chưa làm.
- **Preview chạy bất đồng bộ** trong worker (LLM quá chậm cho một request). Submit playbook chưa bắt buộc preview ≥ 10 mẫu: tenant mới chưa có account nào để chạy preview trước run đầu tiên. Gắn preview vào G-T1 làm cùng Decision Inbox (M5). Chưa có golden sample (`sample=golden` trả 422).
- **Mỗi call LLM là một DBOS step;** riêng bước fetch theo hints là một step cho cả nhóm trang.
- **Global suppression chưa lan tới contact đã giao cho tenant** (`suppressed_by_source`); hiện chỉ chặn ở mọi lookup mới. Lan truyền cần sweep theo từng tenant (Phase 2).
- **Card G-Q và W1** (soạn email đầu tiên) thuộc M5. Q1 dừng ở scorecard và S2.
- **Eval:** test dùng `ScriptedLlm`; chưa đo precision trên golden set (cần dữ liệu gán nhãn của design partner).

### Trạng thái M5
- [x] **W1 Outreach Writer** (`packages/inbox`):
  - Một call `medium` chỉ dùng fact đã kiểm chứng: tiêu chí pass có quote verified, kèm summary.
  - Validator bằng code: độ dài, avoid list của pack, không hứa hẹn, không emoji, tối đa 2 dấu "!", không link hay domain, phải có một câu hỏi CTA, `personalization_basis` phải trỏ tới fact đã kiểm chứng.
  - Sai thì thử lại một lần, kèm danh sách lỗi làm feedback; vẫn sai thì card chỉ có G-Q và rep tự viết email.
  - Footer CAN-SPAM để dạng placeholder `{{footer}}`, sẽ chèn lúc gửi ở Phase 2.
- [x] **Card G-Q + G-OUT:** worker chạy S2 xong (hoặc account đã đủ contact) thì đề xuất card.
  - Hai decision dùng chung `card_id`, làn `contact`, assignee `sales_rep`, SLA 1 ngày làm việc, hết hạn sau 14 ngày, `group_key` theo IPP.
  - Account chuyển sang `carded`. Tính 2 Agent Credit lúc tạo card (D12). Mỗi account chỉ có một card đang chờ.
- [x] **Decision Inbox API:**
  - `GET /cards` (table view), `GET /cards/{id}` (scorecard, quote kèm URL evidence, contact đã giải mã, draft, credit).
  - `POST /cards/{id}/approve`:
    - Đổi lựa chọn contact thì G-Q thành `edited`; sửa draft thì G-OUT thành `edited`.
    - `send_first_email: false` thì G-OUT bị reject với lý do `bad_email_draft`.
    - Duyệt và thực thi trong một transaction.
  - `POST /cards/{id}/reject` dùng reason chuẩn hoá (`other` bắt buộc có note). Account về `prospect` với cooldown 90 ngày, sourcing dedupe nó thành `recently_contacted`.
  - `POST /cards/{id}/snooze` (≤ 30 ngày).
  - `POST /cards/bulk-approve` (≤ 100 card, mỗi card một transaction và một bản ghi decision riêng; card có hash lệch bị bỏ qua và trả về `updated_review_again`).
  - G-Q và G-OUT không duyệt được qua `/decisions` (409, chuyển sang `/cards`).
- [x] **Bất biến email draft:** trigger DB chặn `email_drafts.status ∈ {approved, edited, queued, sent}` khi chưa có G-Q `approved/edited/executed` cùng card (exit criterion Phase 1). Có test.
- [x] **Supersede và expiry:**
  - Trigger trên `accounts` (flag competitor / existing_buyer / do_not_contact, hoặc `blocked`) và trên `contacts` (contact được đề xuất bị suppress) chuyển card đang chờ sang `superseded`, đưa account về `prospect` và bỏ draft.
  - `expire_due_decisions()` (SECURITY DEFINER, worker chạy mỗi phút) xử lý card hết hạn.
- [x] **Metering nội bộ** (`@abcrm/core`, pricing doc §3–4):
  - `usage_balances` theo tháng, tạo từ plan (seed plan và giá overage ở migration 0008).
  - Kiểm tra số dư trước công việc tính phí: sourcing, Q1, preview, contact lookup, card. `recordUsage` trừ số dư trong cùng transaction.
  - Event ngưỡng 50/80/100% và `billing.balance.exhausted`.
  - Hard stop (trial, starter) hoặc overage có spend cap theo meter; `PATCH /usage/settings` (owner/admin); `GET /usage` theo action và theo agent.
- [x] **Guardrails theo agent:**
  - Ngân sách ngày/tháng (`PATCH /agents/{id}`) → pause lý do `budget`.
  - Anomaly: trong ngày vượt 3× trung bình 7 ngày thì phát event, vượt 5× thì pause.
  - Quality breaker: dưới 20% được duyệt trên ≥ 50 card gần nhất thì pause.
  - Pause/resume thủ công (`agents.manage`).
  - Agent S1 bị pause thì run chuyển `paused`; W1/Q1 bị pause thì bỏ qua.
  - Kill switch: `POST /tenant/kill-switch` (owner/admin).
- [x] **G-T1 cho playbook** đính kèm preview hoàn tất mới nhất cùng `definition_hash` vào `decisions.evidence`.

Khác biệt so với spec, đã ghi lại:
- **Chưa có UI** (Next.js, phím tắt, prefetch); M5 làm API mà UI sẽ dùng.
- **Thông báo** (digest buổi sáng, push) và **reassign/escalate khi quá SLA** chưa làm. SLA tính bằng 24 giờ bỏ qua cuối tuần, chưa theo giờ làm việc của từng rep.
- **Assignee:** card giao cho role `sales_rep`, chưa round-robin theo người. Mọi rep đều thấy mọi card.
- **Charge sau khi làm:** kiểm tra số dư trước, trừ sau. Nhiều action chạy đồng thời có thể vượt spend cap tối đa một action. Chưa reserve/release theo lô; chưa có Stripe Meters.
- **Concurrency theo plan** chưa áp dụng (cần DBOS queue theo tenant).
- **"Mark as verified by me"** cho tiêu chí unknown chưa làm.

### Trạng thái M5.1 (phần còn lại của M5, trừ UI)
- [x] **Giữ trước và hoàn credit** (pricing doc §4 bước 1–3):
  - `reserveCredits` là một `UPDATE` có điều kiện trên `usage_balances` (cột `reserved`), nên nhiều reservation chạy đồng thời không thể cùng vượt cap.
  - `recordUsage` / `releaseReservation` tính đúng số thực dùng và trả phần dư. Áp dụng cho sourcing (mỗi domain), Q1, preview, contact lookup (giữ `limit` credit, tính theo số contact thật) và tạo card.
  - Reservation treo quá 1 giờ (worker crash) được `release_stale_reservations()` trả lại.
  - Không còn khả năng vượt spend cap thêm một action như ở M5.
- [x] **Giao card và SLA theo giờ làm việc:**
  - Card chia lần lượt cho rep: ưu tiên rep đang trong giờ làm (`users.working_hours`, `timezone`), rồi rep ít card đang chờ nhất, rồi rep lâu chưa được giao nhất. Không có rep thì giao head_of_bd.
  - SLA = một ngày làm việc của người được giao, tính theo múi giờ của họ (đúng cả khi đổi giờ mùa hè/đông, DST).
  - Sales rep chỉ thấy card của mình và card chưa giao; `?mine=true`.
  - `POST /cards/{id}/reassign` cần quyền mới `decisions.reassign` (owner, admin, head_of_bd).
- [x] **Escalation:** worker quét `due_escalations()`.
  - Quá SLA: báo assignee (level 1).
  - Quá SLA thêm 4 giờ: chuyển cho rep khác đang trong giờ làm, nếu không có thì cho head_of_bd, và báo head_of_bd (level 2).
- [x] **Thông báo** (`packages/notify`):
  - Thông báo in-app (`GET /notifications`, `POST /notifications/{id}/read`), gửi email qua adapter `Mailer`.
  - **Postmark đang tắt** cho tới khi có `POSTMARK_SERVER_TOKEN` và `NOTIFY_FROM_EMAIL`; khi tắt, email được đánh dấu `skipped` và bản in-app vẫn còn.
  - Digest lúc 08:00 theo giờ địa phương mỗi người (`digest_due_users()`, mỗi ngày một lần).
  - Credit dùng 80%/100% thì báo owner/admin; agent bị pause (trừ pause thủ công) thì báo owner/admin/head_of_bd.
- [x] **Báo usage sang Stripe Meters** (`packages/billing`):
  - Mỗi giờ gộp usage của các giờ đã trọn theo tenant và meter (`claim_usage_reports()`, identifier idempotent `<tenant>:<meter>:<hour>`).
  - **Adapter Stripe đang tắt** cho tới khi có `STRIPE_SECRET_KEY`; khi tắt, các giờ được đánh dấu `skipped`. Tenant chưa có `stripe_customer_id` cũng `skipped`; lỗi thì `failed` và được thử lại.
- [x] **Concurrency theo plan:** mỗi plan có một partitioned DBOS queue `agents-<plan>` với `partitionConcurrency = max_concurrency`, partition theo tenant. Q1, S2/card, preview, lookup và sourcing run đều đi qua queue. Có test chứng minh giới hạn áp riêng cho từng tenant.
- [x] **"Mark as verified by me":** `POST /cards/{id}/criteria/{key}/verify {note}`; chỉ cho tiêu chí `unknown`; scorecard giữ nguyên; ghi chú hiện trong `GET /cards/{id}` (`verified_by`).
- [x] Một vòng bảo trì mỗi phút (`maintenanceOnce`): card hết hạn, reservation treo, escalation, digest, usage hằng giờ. Từng job idempotent và lỗi của job này không chặn job khác.

Còn lại:
- **UI Decision Inbox:** xong ở đợt 2 (xem bên dưới).
- Gắn `stripe_customer_id` khi tenant đăng ký và đồng bộ số seat sang subscription (cùng lúc với billing UI và luồng signup).
- Đối soát usage hằng ngày với Stripe (cần dữ liệu thật từ Stripe).

### Trạng thái UI (đợt 2, `apps/web`)
- [x] **Next.js 16 (App Router) làm BFF:**
  - Trình duyệt chỉ giữ cookie phiên `abcrm_session` (httpOnly, mã hoá AES-256-GCM bằng `ABCRM_WEB_SESSION_SECRET`). Access token không bao giờ tới JavaScript phía trình duyệt.
  - `/api/v1/*` chuyển tiếp sang Hono API kèm Bearer token. Mọi mutation phải có header `x-abcrm-csrf: 1` (thiếu → 403); path chứa `..` bị từ chối.
  - `proxy.ts` chặn trang khi chưa đăng nhập: trang thì chuyển về `/login?next=`, `/api` thì trả 401. Access token WorkOS sắp hết hạn được refresh tự động.
- [x] **Đăng nhập:**
  - WorkOS AuthKit (`/auth/signin` → `/auth/callback`, kiểm tra `state`).
  - Dev sign-in (tenant + user ID, dùng dev token của API), chỉ bật khi `ABCRM_DEV_AUTH=1` và không phải production (hoặc `ABCRM_WEB_ALLOW_DEV=1`, chỉ dùng cho e2e/CI).
  - `next` được kiểm tra để chống open redirect.
- [x] **Decision Inbox, table view** (`/inbox`):
  - Nhóm theo IPP; cột tier/score, top reason, contact, dòng đầu email (AI), SLA, assignee; lọc "của tôi" và card đang snooze.
  - Duyệt theo nhóm: chọn từng card hoặc cả nhóm → `bulk-approve`; card đổi từ lúc tải bị bỏ qua và đánh dấu "updated, review again".
- [x] **Card view** (`/inbox/{id}`):
  - Why fit / Risks, tiêu chí kèm quote có highlight và link nguồn, "Mark as verified by me" cho tiêu chí unknown.
  - Chọn contact, email đầu tiên với phần AI viết được highlight, sửa subject/body.
  - Reject theo reason chuẩn (`other` cần note), snooze tới 09:00 sáng hôm sau, reassign (owner/admin/head_of_bd).
  - Phím tắt: `A` duyệt và xếp email, `⇧A` duyệt không gửi email, `R` reject, `S` snooze, `E` sửa, `J`/`K` card sau/trước, `Esc` huỷ. Phím tắt không chạy khi đang gõ trong ô nhập.
  - Prefetch 5 card kế tiếp; quyết định xong tự sang card kế.
- [x] **Setup** (`/setup`): duyệt G-T1 (Approve theo `content_hash` hoặc trả về bản nháp), xem preview đính kèm, Supply Profile, clone vertical pack, danh sách playbook/IPP, sửa playbook (criteria) và chạy preview, sửa IPP.
- [x] **Sourcing** (`/sourcing`): tạo run (ước tính chi phí trước khi chạy), pause/resume/cancel.
- [x] **Usage** (`/usage`): số dư (đã dùng + đang giữ trên mức included), theo action, theo agent; spend cap và overage (owner/admin).
- [x] **Agents** (`/agents`): ngân sách ngày/tháng, pause/resume, kill switch (owner/admin).
- [x] **Notifications** (`/notifications`): danh sách, đánh dấu đã đọc; số chưa đọc hiện trên thanh điều hướng.
- [x] API bổ sung cho UI: `/v1/me` trả thêm `user` (tên, timezone, giờ làm việc), `GET /v1/users` (danh sách người để reassign).
- [x] **Test:**
  - Unit (vitest): highlight AI span, map phím tắt, 09:00 sáng hôm sau, chống open redirect, seal/unseal cookie, parse summary.
  - E2E (Playwright, chạy trong CI trên bản build production và database seed riêng): đăng nhập dev, duyệt một card bằng phím `A`, duyệt nhóm 2 card còn lại; BFF từ chối mutation thiếu CSRF header và request chưa đăng nhập.

Khác biệt so với spec, đã ghi lại:
- **Giao diện tiếng Anh;** tiếng Việt thuộc phạm vi sau Phase 1.
- **Chưa có trang API key và billing** (Stripe adapter đang tắt). Undo, import UI và quản lý user làm ở đợt 3 (bên dưới).

### Trạng thái UI đợt 3 (trước M6)
- [x] **Quản lý user** (`/team`, quyền mới `users.manage`: owner, admin):
  - Mời theo email và role → user `invited`; khi có `WORKOS_API_KEY` và tenant có `workos_org_id`, API gửi WorkOS invitation, ngược lại trả `invitation.sent = false` kèm lý do. Gửi lại lời mời được.
  - Lần đăng nhập WorkOS đầu tiên: API lấy email **đã xác minh** của user từ WorkOS, `activate_workos_invite()` gắn WorkOS identity vào lời mời cùng email trong cùng organization (một lần; user WorkOS khác cùng email không chiếm được). Dev sign-in của user invited cũng kích hoạt. Người mời nhận thông báo.
  - Đổi role, vô hiệu hoá/bật lại. Chặn tự khoá: không đổi role của chính mình, không tự vô hiệu hoá; chỉ owner mời/sửa owner; luôn còn ít nhất một owner active.
  - Vô hiệu hoá: user bị từ chối ngay ở request kế tiếp; card đang chờ của họ được chia lại theo round-robin. Lời mời chưa dùng mà bật lại thì về `invited`.
  - Mỗi người tự sửa tên, timezone, giờ làm việc (`PATCH /users/me`, có validate); SLA card và digest 08:00 dùng các giá trị này.
  - Email user lưu chữ thường (migration 0010).
- [x] **Import UI** (`/imports`, owner/admin): chọn loại dữ liệu (accounts, contacts, existing buyers, do-not-contact), upload CSV/XLSX qua BFF (multipart, ≤ 20 MB), chỉnh mapping cột (báo thiếu field bắt buộc, field bị map hai lần), dry-run (số dòng hợp lệ/cảnh báo/lỗi, 50 dòng lỗi đầu), commit, rollback, lịch sử import (`GET /imports`).
- [x] **Undo 5 giây:**
  - Approve và reject chờ 5 giây trước khi gửi; rep sang card kế ngay. Thanh dưới màn hình có nút Undo và đếm ngược; phím `U` hoàn tác và mở lại card.
  - Card đang chờ gửi bị ẩn khỏi bảng và khỏi thứ tự J/K. Quyết định mới trên cùng card thay quyết định đang chờ.
  - Đóng tab hoặc rời trang trong 5 giây: quyết định được gửi ngay (`fetch keepalive`), không bị mất. Gửi lỗi (ví dụ card đã đổi) thì thanh báo lỗi kèm link mở lại card.
  - Duyệt theo nhóm (bulk) và snooze không có undo.
- [x] Test: API (mời, kích hoạt qua WorkOS và dev, chặn tự khoá, chuyển card khi vô hiệu hoá, hồ sơ, lịch sử import, cross-tenant fuzz cho route `/users/:id`), unit (hàng đợi undo, giờ làm việc, mapping), e2e (undo bằng `U`; admin mời user, import CSV → dry-run → commit → rollback).

### Trạng thái M6
- [x] **Vertical pack Finance và Home Services** (`packages/setup/packs/finance.yaml`, `home_services.yaml`, bản sao trong `vertical-packs/`):
  - Finance: debt relief, personal loans, tax relief, credit repair, mortgage/refi, business funding; 3 IPP template; tiêu chí riêng (giấy phép/NMLS, yêu cầu tối thiểu của buyer khớp supply, rủi ro thanh toán nặng hơn).
  - Home Services: solar, roofing, HVAC, windows/doors, remodel, home warranty, pest control, gutters, walk-in tubs; 3 IPP template; tiêu chí service area nhiều bang, bộ lọc homeowner.
  - Avoid list theo ngành (ví dụ "approval guaranteed", "free solar", "government program") và compliance notes.
  - Tech detector mới: LeadConduit, Phonexa.
  - `lintPack()` kiểm tra mọi pack trong CI; vẫn `status: draft` cho tới khi qua eval gate trên golden set.
- [x] **Eval** (`packages/evals`, test-plan §5):
  - Suite deterministic chạy mỗi PR (`pnpm eval`): I1 mapping, S2 title, W1 validator, injection-20. Gate theo §5.2 và chặn tụt > 3 điểm so với `baseline.json` (§5.3).
  - Suite Q1 trên golden set với model thật (`--live`), workflow nightly `evals-nightly.yml`; bỏ qua khi chưa có model hoặc golden set.
  - Eval phát hiện và đã sửa: header tiếng Việt có "đ" (Số điện thoại, SĐT) không nhận; header "Advertiser", "Bang", "Ngành", "Category"; synonym group của title không gắn vào target (ví dụ "Lead Acquisition Manager" không nhận "Lead Buyer", "Media Buyer").
- [x] **Hardening:**
  - Bỏ text ẩn (display:none, hidden, aria-hidden, chữ cỡ 0, opacity 0, đẩy ra ngoài màn hình) trước khi tới S1/Q1: chặn prompt injection giấu trong trang.
  - API: rate limit theo user/API key (600/phút) và theo IP cho đăng nhập thất bại (30/phút, `Retry-After`); giới hạn body 1 MB (upload import 21 MB); security headers; log lỗi không chứa giá trị dòng DB (redaction).
  - BFF chuyển `X-Forwarded-For` của trình duyệt để giới hạn theo IP đúng người.
  - Property test INV-1 (chuỗi thao tác card ngẫu nhiên, gồm ghi thẳng DB).
  - Thời gian duyệt card (`decisions.review_ms`, migration 0011) đo ở web.
- [x] **Vận hành:**
  - `pnpm report:exit-criteria`: số liệu exit criteria Phase 1 theo tenant (card G-Q, precision Tier A, quote chưa kiểm chứng, coverage, chi phí/credit, INV-1, trung vị thời gian duyệt, đối soát credit).
  - `pnpm tenant:create`: tạo tenant và owner được mời (kích hoạt khi đăng nhập WorkOS lần đầu). `pnpm db:rls-check`: kiểm tra RLS chỉ đọc.
  - `render.yaml` (Render Blueprint) và 6 runbook trong [`docs/runbooks`](../../runbooks/README.md).
  - [Rà soát exit criteria](./exit-criteria-review.md).

Khác biệt so với spec, đã ghi lại:
- Seed dataset nhỏ hơn quy mô trong test-plan và do team gán nhãn; golden set S1/Q1 cần design partner.
- Rate limit nằm trong bộ nhớ của từng instance API (đủ cho một instance ở Phase 1).
- `render.yaml` chưa chạy trên tài khoản Render thật.
