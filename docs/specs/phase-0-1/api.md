# REST API (Phase 0–1)

Hono và `@hono/zod-openapi`; OpenAPI 3.1 sinh tự động tại `/v1/openapi.json`. UI (Next.js) gọi cùng API với session cookie; public API dùng `Authorization: Bearer abk_…`.

## 1. Quy ước
- Base: `https://us.abcrm.app/v1` (cell `us`).
- Auth: WorkOS session (UI) hoặc API key có scope. Mọi request được resolve sang `tenant_id` và actor.
- Ghi: header `Idempotency-Key` (bắt buộc với POST tạo tài nguyên từ public API; khuyến nghị cho UI).
- Optimistic locking: `If-Match: <version|etag>` cho PATCH.
- Pagination: cursor `?cursor=…&limit=50` (max 200) → `{ data, next_cursor }`.
- Lọc: `?filter[status]=pending&filter[lane]=contact`.
- Lỗi theo RFC 9457:
  ```json
  { "type": "https://docs.abcrm.app/errors/quota-exhausted", "title": "Agent credits exhausted",
    "status": 402, "detail": "…", "instance": "/v1/sourcing-runs/…", "meter": "agent" }
  ```
  | type | status |
  |---|---|
  | `validation-failed` | 422 |
  | `not-found` (gồm truy cập chéo tenant, **không bao giờ 403**) | 404 |
  | `permission-denied` | 403 |
  | `quota-exhausted` | 402 |
  | `gate-required` | 409 (hành động cần decision) |
  | `conflict` / `precondition-failed` | 409 / 412 |
  | `rate-limited` | 429 |

## 2. Endpoints

### 2.1 Session & tenant
| Method | Path | Mô tả |
|---|---|---|
| GET | `/me` | User, tenant, role, plan, entitlements, balances |
| PATCH | `/me` | timezone, working_hours, locale |
| GET/POST | `/users` · PATCH/DELETE `/users/{id}` · POST `/users/{id}/resend-invite` | Quản lý user (owner/admin): mời qua WorkOS, đổi role, vô hiệu hoá (DELETE = disable, không xoá dòng). `GET /users?all=true` gồm cả user invited/disabled |
| PATCH | `/users/me` | Hồ sơ của chính mình: tên, timezone, giờ làm việc, locale |
| GET/POST | `/api-keys` · DELETE `/api-keys/{id}` | API keys |
| POST | `/tenant/kill-switch` | `{enabled}` (owner/admin) |

### 2.2 Setup
| Method | Path | Mô tả |
|---|---|---|
| GET | `/supply-profile` | Version active và draft |
| PUT | `/supply-profile/draft` | Lưu draft |
| POST | `/supply-profile/draft/submit` | Tạo G-T1 |
| GET/POST | `/playbooks` · GET `/playbooks/{id}` | Danh sách theo lineage, version |
| POST | `/playbooks/{id}/versions` | Tạo draft version mới từ version hiện tại |
| PUT | `/playbooks/{id}/criteria` | Thay toàn bộ criteria (chỉ khi draft) |
| POST | `/playbooks/{id}/preview` | `{sample: "golden"|"recent", size≤20}` → `202`; worker chạy preview (tính credit) |
| GET | `/playbooks/{id}/previews` · `/playbook-previews/{id}` | Trạng thái, phân bố tier, kết quả từng account |
| POST | `/playbooks/{id}/submit` | Tạo G-T1 |
| GET/POST | `/ipps` · GET `/ipps/{id}` · POST `/ipps/{id}/versions` · POST `/ipps/{id}/submit` | Tương tự playbook |
| GET | `/vertical-packs` · GET `/vertical-packs/{key}` | Template IPP, playbook, query |
| POST | `/vertical-packs/{key}/clone` | Tạo draft IPP và playbook từ pack |

### 2.3 Sourcing
| Method | Path | Mô tả |
|---|---|---|
| POST | `/sourcing-runs/estimate` | `{ipp_id, target_count}` → `{agent_credits, contact_credits, requires_approval}` |
| POST | `/sourcing-runs` | `{ipp_id, target_count, agent_credit_budget, contact_credit_budget}` → `201` (status `queued` hoặc `pending_approval`) |
| GET | `/sourcing-runs` · `/sourcing-runs/{id}` | Tiến độ, stats |
| POST | `/sourcing-runs/{id}/pause` · `/resume` · `/cancel` | Điều khiển |
| GET | `/sourcing-runs/{id}/candidates` | Lọc theo status, tier |
| POST | `/candidates/manual` | `{domain, name?, note?}` thêm thủ công vào qualification |

### 2.4 CRM
| Method | Path | Mô tả |
|---|---|---|
| GET | `/accounts` (search `q`, filter status/vertical/tier/flags) · GET `/accounts/{id}` | Gồm scorecard mới nhất, evidence, contacts |
| PATCH | `/accounts/{id}` | Sửa trường; ghi `record_changes` actor user |
| POST | `/accounts/{id}/flags` | `{add:[competitor|existing_buyer|do_not_contact], remove:[]}` |
| GET | `/accounts/{id}/evidence` · `/accounts/{id}/scorecards` · `/scorecards/{id}` | Bằng chứng, lịch sử scorecard, scorecard đầy đủ (criteria, quote đã kiểm chứng) |
| POST | `/accounts/{id}/contacts/find` | `{titles?, limit≤5}` → `202`; worker chạy Contact Data Layer (Contact Credits); titles mặc định lấy từ IPP active |
| GET | `/contact-lookups/{id}` | Trạng thái lookup, contact trả về, credit đã tính |
| GET/PATCH | `/contacts/{id}` | Contact (PII giải mã theo quyền) |
| GET/POST | `/opportunities` · PATCH `/opportunities/{id}` | Pipeline tối thiểu |
| GET/POST | `/accounts/{id}/activities` | Notes, tasks |
| GET/POST/DELETE | `/suppression` | Email/domain blocklist (tenant) |
| POST | `/exports/approved-contacts` | CSV các account/contact/draft đã duyệt (chuyển tiếp trước Phase 2) |

### 2.5 Decision Inbox
| Method | Path | Mô tả |
|---|---|---|
| GET | `/decisions` | `filter[status]=pending&filter[lane]=…&group_by=group_key` |
| GET | `/cards/{card_id}` | Card đầy đủ (account, scorecard, evidence, contacts, draft) |
| POST | `/cards/{card_id}/approve` | `{contact_ids:[…], draft?:{subject, body}, send_first_email: boolean}` → approve G-Q (+ G-OUT nếu `send_first_email`); edited nếu sửa |
| POST | `/cards/{card_id}/reject` | `{reason_code, note?}` |
| POST | `/cards/{card_id}/snooze` | `{until}` (ISO, ≤ 30 ngày) |
| POST | `/cards/{card_id}/reassign` | `{user_id}` (owner/admin/head_of_bd) |
| POST | `/cards/{card_id}/criteria/{key}/verify` | `{note}`: "Mark as verified by me" cho tiêu chí unknown |
| GET · POST | `/notifications` · `/notifications/{id}/read` | Thông báo in-app của người đăng nhập (`?unread=true`) |
| GET | `/cards` · `/cards/{card_id}` | Inbox (table view: tier, top reason, contact, dòng đầu email, `content_hash` của card) · chi tiết card |
| POST | `/cards/bulk-approve` | `{card_ids:[…≤100], content_hashes:{card_id: hash}}`: grouped review; mỗi decision có bản ghi riêng; card nào hash lệch (đã thay đổi) thì bị bỏ qua và trả về danh sách |
| POST | `/decisions/{id}/approve` · `/reject` | Decision đơn (G-T1…). Approve: `{content_hash}` (hex, lấy từ GET); hash lệch thì 412; approve và execute trong một transaction. Reject: `{reason_code, note?}` |

### 2.6 Agents & usage
| Method | Path | Mô tả |
|---|---|---|
| GET | `/agent-templates` | Template được phép theo plan |
| GET/POST | `/agents` · GET/PATCH `/agents/{id}` | Tenant agents (tạo không giới hạn); PATCH: `credit_budget_daily`, `credit_budget_monthly` (Phase 1: agent mặc định theo template, tạo tự động) |
| POST | `/agents/{id}/pause` · `/resume` | |
| GET | `/agents/{id}/runs` · `/runs/{run_id}` | Trace đã redact |
| GET | `/usage` | Balances theo meter, theo agent, theo run; dự báo |
| PATCH | `/usage/settings` | `{meter, overage_enabled?, spend_cap_usd?}` (owner/admin) |

### 2.7 Import
| Method | Path | Mô tả |
|---|---|---|
| GET | `/imports` | Lịch sử import (mới nhất trước) |
| POST | `/imports` | `multipart: file, purpose` → staged |
| GET | `/imports/{id}` | Trạng thái, stats, `targets` (field và nhóm bắt buộc theo purpose) |
| GET/PUT | `/imports/{id}/mapping` | Mapping đề xuất (I1) và chỉnh sửa |
| POST | `/imports/{id}/dry-run` · `/commit` · `/rollback` | |

### 2.8 Privacy (công khai, không cần auth)
| Method | Path | Mô tả |
|---|---|---|
| POST | `https://abcrm.app/privacy/requests` | Chủ thể dữ liệu yêu cầu opt-out/xoá: xác minh email, rồi ghi `global_data_suppression` (FR-S13) |

## 3. Ví dụ: approve card
```http
POST /v1/cards/9b1e…/approve
Idempotency-Key: 6f0c…
Content-Type: application/json

{ "contact_ids": ["c1…"], "send_first_email": true,
  "draft": { "subject": "Medicare data leads with TrustedForm — quick test?", "body": "Hi Jane, …" } }
```
```json
200 OK
{ "card_id": "9b1e…",
  "decisions": [
    { "id": "d1…", "gate_id": "G-Q",   "status": "approved" },
    { "id": "d2…", "gate_id": "G-OUT", "status": "edited", "final_content_hash": "…" } ],
  "account": { "id": "a1…", "status": "approved" },
  "email_draft": { "id": "e1…", "status": "approved" } }
```
