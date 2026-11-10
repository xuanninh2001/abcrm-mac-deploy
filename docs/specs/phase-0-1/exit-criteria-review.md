# Rà soát exit criteria Phase 0–1 (M6)

Ngày rà soát: 2026-10-26. Đối chiếu [README §4](./README.md#4-exit-criteria) và [test-plan §8](./test-plan.md#8-acceptance-map-tới-readme-4).
Ký hiệu: ✅ đạt, có bằng chứng · 🟡 công cụ đo đã có, cần dữ liệu thật hoặc việc ngoài code · ⬜ chưa làm.

## Phase 0
| Tiêu chí | Trạng thái | Bằng chứng / việc còn lại |
|---|---|---|
| Cross-tenant test xanh cho 100% endpoint | ✅ | `apps/app/test/api.test.ts` "cross-tenant fuzz": duyệt **mọi** route `GET/PATCH/POST/PUT/DELETE` có `:id` từ router (route mới thiếu fixture thì test fail), kỳ vọng 404; list endpoint không lộ dòng tenant khác. `pnpm db:rls-check` và test RLS trong `packages/db`. |
| Import 10k account, rollback thành công | ✅ | Đo trên Postgres 16 local (2026-10-26): 10.000 dòng: stage 0,16 s, dry-run 0,23 s, commit 74 s, rollback 7 s; tạo 10.000, xoá 10.000. Giới hạn đã biết: commit chạy trong một request HTTP, nên file > ~10k dòng có thể vượt timeout của proxy; chuyển commit sang worker là việc tiếp theo. |
| ≥ 2 license contact data provider (resale/embedded) | 🟡 | Việc kinh doanh. Code: interface `ContactProvider`/`EmailVerifier` và waterfall đã có; bật vendor = thêm adapter và dòng `data_providers`. |
| Deploy một lệnh; PITR được kiểm tra | 🟡 | `render.yaml` (api, worker, web; migration ở `preDeployCommand`) và [runbook 01](../../runbooks/01-deploy.md). Cần: apply Blueprint trên Render thật và kiểm tra PITR lần đầu theo [runbook 04](../../runbooks/04-backup-restore.md). |

## Phase 1 (3 design partners)
Đo bằng `pnpm report:exit-criteria [--since] [--tenant]` (`packages/db/src/exit-criteria.ts`), chạy hằng tuần theo [runbook 02](../../runbooks/02-onboarding-design-partner.md).

| Tiêu chí | Trạng thái | Cách đo / bằng chứng |
|---|---|---|
| Mỗi tenant ≥ 300 card G-Q | 🟡 | Số decision G-Q theo tenant. Cần design partner chạy thật. |
| Precision Tier A ≥ 70% | 🟡 | Online: tỉ lệ card Tier A được duyệt trên card Tier A đã quyết định. Offline: suite Q1 trên golden set (`pnpm eval --live`, nightly), chờ golden set từ partner. |
| 0 quote không kiểm chứng trên card | ✅ (thiết kế) / 🟡 (số liệu thật) | Q1 chỉ lưu quote khớp nguyên văn (ADR-013); report đếm quote `verified ≠ true` trên scorecard có card (phải = 0). Eval `injection.quote_guard` = 1,0 trong CI. |
| Coverage contact verified ≥ 60% (Tier A/B) | 🟡 | Report: account Tier A/B có ≥ 1 contact `valid`. Phụ thuộc provider thật. |
| Chi phí ≤ $0,0024/Agent Credit, ≤ $0,10/Contact Credit | 🟡 | Report: `cost_ledger` (llm+search+fetch; contact_provider+email_verify) chia credit billable. Cần chạy thật để có số. |
| Không có đường tạo `email_drafts.status='approved'` thiếu G-Q approved | ✅ | Trigger DB; property test INV-1 (`packages/inbox`, 25 chuỗi thao tác ngẫu nhiên gồm ghi thẳng DB); report đếm vi phạm (phải = 0). |
| Rep duyệt một card < 30 s trung vị | 🟡 | Web gửi `review_ms` (từ lúc mở card tới lúc quyết định, không tính 5 giây undo); report tính trung vị. Cần dữ liệu thật. |

## Eval gates (test-plan §5.2)
| Agent | Metric | Ngưỡng | Kết quả hiện tại | Nguồn |
|---|---|---|---|---|
| I1 | mapping accuracy | ≥ 0,90 | 0,995 (31 file, 197 cột) | `datasets/i1` (seed) |
| S2 | title precision | ≥ 0,85 | 1,00 (recall 1,00; 73 title, 3 pack) | `datasets/s2` (seed) |
| W1 | validator khớp nhãn; vi phạm avoid lọt qua | 1,0; 0 | 1,0; 0 | `datasets/w1` (20 draft) |
| Tất cả | injection-20 | 100% | 100% (10 trang ẩn chỉ dẫn, 10 quote) | `datasets/injection` |
| S1, Q1 | precision, recall trên golden set | theo bảng | chưa có golden set | `datasets/golden` (partner) |

Seed dataset do team tự gán nhãn, nhỏ hơn quy mô trong test-plan (`titles-300`, `imports-30` thật). Thay bằng dữ liệu partner khi có; baseline (`packages/evals/baseline.json`) cập nhật bằng `--update-baseline` trong cùng PR.

## Pack
Insurance, Finance, Home Services (`packages/setup/packs`) qua lint trong CI (template mở rộng hợp lệ, lead type thuộc taxonomy, playbook tồn tại, W1 có angle/avoid/CTA, tech signal có detector). Cả ba vẫn `status: draft` cho tới khi qua eval gate trên golden set của từng vertical.

## Việc còn lại trước khi đóng Phase 1
1. Onboard 3 design partner (runbook 02) và chạy report hằng tuần.
2. Thu golden set (Insurance 200, Finance 100, Home 100) và bật eval Q1 nightly (`EVAL_GOLDEN_DIR`, secret `ANTHROPIC_API_KEY`).
3. Ký ≥ 2 provider, viết adapter.
4. Apply `render.yaml`, kiểm tra PITR, ghi nhật ký.
5. Chuyển import commit sang worker (file lớn).
