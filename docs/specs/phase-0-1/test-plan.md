# Test Plan (Phase 0–1)

## 1. Tầng test & công cụ
| Tầng | Công cụ | Chạy khi |
|---|---|---|
| Unit | Vitest | Mỗi commit |
| Property-based | fast-check | Mỗi commit (policy, scoring, metering) |
| Integration (DB thật) | Vitest + Postgres container (Neon branch ở CI) | Mỗi PR |
| E2E | Playwright | Mỗi PR (smoke), nightly (full) |
| Agent evals | Eval runner nội bộ (dataset theo pack) + LLM-as-judge | PR đổi prompt/template/model; nightly |
| Load | k6 | Trước mỗi milestone |

## 2. Tenant isolation (blocking)
1. **RLS smoke** ([`rls_smoke_test.sql`](./rls_smoke_test.sql)) chạy trong CI sau mỗi migration.
2. **Coverage check**: script liệt kê mọi bảng trong schema `abcrm`; bảng có cột `tenant_id` mà **không** có `relforcerowsecurity = true` và policy `tenant_isolation` thì **fail**. Bảng global phải nằm trong allowlist (`public_pages`, `robots_cache`, `crawl_policy`, `data_providers`, `licensed_contact_cache`, `global_data_suppression`, `global_contact_pressure`, `agent_templates`, `plan_entitlements`).
3. **Cross-tenant API fuzz**: seed tenant A và B; với mọi route trong OpenAPI, gọi bằng token của B với ID tài nguyên của A, kỳ vọng `404` (không bao giờ 200/403).
4. **No-context**: repository gọi DB mà không có `app.tenant_id` thì trả 0 dòng (test integration) và bị lint chặn ở type-level.
5. **Global tables**: role `abcrm_app` truy cập bảng global thì `permission denied`.
6. **Storage**: object key luôn bắt đầu bằng `tenant/<id>/`; test signed URL với tenant khác thì bị từ chối.

## 3. Invariants (property-based)
| ID | Thuộc tính | Cách kiểm |
|---|---|---|
| INV-1 | Không có `email_drafts.status='approved'` nếu thiếu G-Q `approved` của cùng account và G-OUT `approved/edited` khớp hash | Sinh chuỗi thao tác ngẫu nhiên (propose, edit, approve, reject, supersede, retry) rồi kiểm DB |
| INV-2 | Agent/persona không bao giờ có thể chuyển decision sang approved | Gọi approve với actor agent thì luôn bị từ chối |
| INV-3 | Mỗi decision được `executed` tối đa 1 lần | Chạy song song executor N lần |
| INV-4 | Criterion `pass` với `evidence_required` luôn có ≥ 1 quote verified | Sinh quote ngẫu nhiên (khớp, không khớp, gần khớp) |
| INV-5 | Tổng điểm và tier chỉ phụ thuộc vào criterion results và playbook (deterministic) | So sánh `finalize` hai lần, hoán vị thứ tự input |
| INV-6 | `web.fetch` không bao giờ gọi ra ngoài với domain trong `crawl_policy deny` | Sinh URL biến thể (subdomain, chữ hoa, redirect tới linkedin.com) |
| INV-7 | Credit không bị tính hai lần khi retry; reserve và release cân bằng | Inject lỗi ở từng step, so sánh `usage_events` với `usage_balances` |
| INV-8 | Contact trong `global_data_suppression` không bao giờ được trả về từ `contact.find` | Seed suppression, chạy lookup với cache và provider mock |
| INV-9 | Kill switch: sau khi bật, không có step agent mới nào bắt đầu | Bật giữa run, kiểm tra step tiếp theo bị huỷ |

## 4. Metering & guardrails
- Bảng trọng số credit (pricing §1) là **fixtures**: test mỗi tool sinh đúng `action_type` và credits.
- Reserve/commit/release cho `contact.find` với các kết quả 0, 1, n verified hoặc catch-all.
- Ngưỡng 50/80/100% phát `billing.balance.threshold_crossed` đúng một lần mỗi ngưỡng mỗi kỳ.
- Starter hard stop: tool tính phí trả `402 quota-exhausted`; compliance actions vẫn chạy.
- Guardrails theo agent: budget ngày; anomaly (> 3× trung bình 7 ngày thì alert, > 5× thì pause); quality breaker (< 20% acceptance trên 50 đề xuất thì pause).
- Đối soát: `Σ usage_events` = `usage_balances.used` (job hằng ngày; lệch thì alert).

## 5. Agent evals & golden set
### 5.1 Datasets
| Dataset | Nội dung | Nguồn |
|---|---|---|
| `golden-insurance-200` | 200 domain buyer với nhãn fit/not-fit, lead types, buyer type, 1–3 contact đúng (nếu có) | Design partners |
| `golden-finance-100`, `golden-home-100` | Tương tự | Design partners (M6) |
| `competitors-50` | Publisher/agency bán lead (để test `not_competitor`) | Founder và design partners |
| `injection-20` | Trang giả chứa chỉ dẫn cho AI, trang "partners" giả | Tự tạo (host trên domain test) |
| `titles-300` | Title thực tế cùng nhãn normalized/match | Provider samples |
| `imports-30` | File CSV/XLSX thật (đã ẩn danh) | Design partners |
| `drafts-rubric` | 50 scorecard và draft, chấm theo rubric | Tự tạo và rep review |

### 5.2 Ngưỡng (gate để publish template hoặc pack)
| Agent | Metric | Ngưỡng |
|---|---|---|
| S1 | precision `isLeadBuyerLikely` · competitor recall · recall@200 | ≥ 0,80 · ≥ 0,85 · ≥ 0,40 |
| S2 | coverage Tier A/B · title precision | ≥ 0,60 · ≥ 0,85 |
| Q1 | Tier A precision · Tier D recall (not-fit) · unverified-quote rate (pre-filter) | ≥ 0,70 · ≥ 0,80 · ≤ 0,05 |
| W1 | factuality · avoid-list violations · rubric "human" | 1,0 · 0 · ≥ 4/5 |
| I1 | field mapping accuracy | ≥ 0,90 |
| Tất cả | injection-20 pass | 100% |

### 5.3 Quy trình
- PR đổi prompt, template, model mapping hoặc pack thì CI chạy eval trên subset (≤ 50 mẫu/agent, dùng cache); nightly chạy full.
- Kết quả lưu theo `template@version × pack@version × model`; giảm so với baseline vượt 3 điểm % thì PR bị chặn.
- **Online metrics** (sau M5): approval rate theo tier, reject reasons, edit distance của draft; dashboard theo design partner.

## 6. Hiệu năng (k6 + workflow load)
| Kịch bản | Mục tiêu |
|---|---|
| API CRUD | p95 < 300ms ở 50 rps |
| Inbox list và card | p95 < 800ms; bulk approve 100 card < 3s |
| Sourcing run 1.000 candidate (cache hit 50%) | Hoàn tất < 2 giờ; không vượt rate limit theo domain |
| DBOS: 10k workflow chờ decision, restart worker | Resume đầy đủ, không mất hoặc trùng step |
| Import 100k dòng | Dry-run < 10 phút; commit < 20 phút |

## 7. Security tests
- Dependency scan (Renovate, `npm audit`), CodeQL/Semgrep, secret scanning: blocking trên PR.
- Kiểm tra redaction: log và trace không chứa email/tên (regex và blind-index match trên mẫu).
- API key: hash-only storage; revoke có hiệu lực < 60s.
- SSRF: `web.fetch` chặn IP private/link-local/metadata, chỉ cho `http(s)`, giới hạn redirect (≤ 3, kiểm lại policy sau mỗi redirect), giới hạn kích thước (≤ 5 MB) và thời gian (≤ 15s).
- Pentest trước GA (cuối Phase 2).

## 8. Acceptance (map tới README §4)
| Exit criterion | Bằng chứng |
|---|---|
| Cross-tenant 100% endpoint | Báo cáo CI §2.3 |
| Precision Tier A ≥ 70% | Dashboard online và golden set (§5) |
| 0 unverified quote trên card | Query kiểm toán `criterion_results.quotes[*].verified = false` trên card = 0 |
| Coverage ≥ 60% | Báo cáo S2 |
| Unit cost trong mục tiêu | Báo cáo `cost_ledger` / `usage_events` |
| INV-1 | Property test và query kiểm toán DB |
| Median < 30s/card | Inbox metrics |
