# abcrm

ABCRM: **Agentic CRM giúp offshore lead gen agency / B2B affiliate tìm và ký hợp đồng với lead buyers tại US** (brand, aggregator, affiliate network; Edu, Insurance, Finance, Legal, Home Services).
Lead Sourcing Agent tìm buyer data lead theo chân dung partner mục tiêu, ABCRM cung cấp contact verified; Qualification Agent chấm theo bộ tiêu chí tenant tự tuỳ chỉnh, có bằng chứng; **chỉ những lead được sales rep duyệt mới được liên hệ**; doanh thu theo buyer đồng bộ từ RedTrack.

## Tài liệu
- [PRD: Đặc tả yêu cầu sản phẩm](docs/01-PRD.md)
- [System Design: Thiết kế hệ thống](docs/02-system-design.md)
- [Roadmap (solo founder)](docs/03-roadmap.md)
- [Pricing & Usage Metering](docs/04-pricing-and-metering.md)
- [Data Import từ Legacy CRM](docs/05-data-import.md)
- [Vertical Packs](docs/06-vertical-packs.md)
- [Architecture Decision Records](docs/adr/)
- [Runbooks vận hành](docs/runbooks/README.md)
- [Đặc tả chi tiết Phase 0–1](docs/specs/phase-0-1/README.md): DDL, events, tools, API, agents, IPP/Playbook, Insurance pack, Decision Inbox, test plan

## Phát triển (Phase 0)

Monorepo TypeScript (pnpm + Turborepo), PostgreSQL là trung tâm (RLS, DBOS). Xem [`docs/specs/phase-0-1`](docs/specs/phase-0-1/README.md).

| Package | Vai trò |
|---|---|
| `packages/db` | Migrations SQL (nguồn sự thật của schema), migrator, `withTenant`, Drizzle schema, kiểm tra độ phủ RLS, test helpers |
| `packages/crypto` | Mã hoá field AES-256-GCM (gắn tenant và cột qua AAD), blind index HMAC, chuẩn hoá email/domain/text, key provider (AWS KMS ở production, local ở dev) |
| `packages/core` | UUIDv7, lỗi RFC 9457, outbox, audit log hash chain, keyring theo tenant, request context, metering (số dư, spend cap, ngưỡng, guardrails theo agent) |
| `packages/llm` | LLM gateway: tier → model Claude, structured outputs, prompt caching, refusal fallback, ghi chi phí; `ScriptedLlm` cho test |
| `packages/qualification` | Thuật toán chấm điểm playbook (deterministic), kiểm chứng quote, rule JSONLogic có allowlist; engine Q1 (rule → AI theo lô → scorecard bất biến), playbook preview |
| `packages/contactdata` | Contact Data Layer: waterfall provider theo license, licensed cache dùng chung, global suppression, match title, verify email, tính Contact Credit theo kết quả |
| `packages/crm` | Account (upsert theo domain, flags, field history), contact (PII mã hoá, dedupe theo email), suppression (lan sang contact, không gỡ được opt-out pháp lý), opportunity, activity |
| `packages/setup` | Supply Profile, Playbook (criteria có validate rule), IPP: bản nháp → G-T1 → kích hoạt version mới; nạp, lint và clone vertical pack (`packs/insurance.yaml`, `finance.yaml`, `home_services.yaml`) |
| `packages/sourcing` | Fetcher lịch sự (chặn SSRF, no-crawl list, robots.txt, giành lượt theo domain toàn hệ thống, cache trang công khai), trích xuất HTML, tech signals, search adapter, engine sourcing có checkpoint và ngân sách, S1 extractor (LLM) |
| `packages/inbox` | Decision Inbox: W1 viết email đầu tiên (validator bằng code), card G-Q + G-OUT, approve/edit/reject/snooze, duyệt theo nhóm, executors, chia card round-robin, SLA theo giờ làm việc, escalation |
| `packages/notify` | Thông báo in-app, adapter email (Postmark, tắt khi chưa có key), digest buổi sáng |
| `packages/billing` | Báo usage hằng giờ sang Stripe Meters (adapter tắt khi chưa có key) |
| `packages/evals` | Eval agent (test-plan §5): suite deterministic mỗi PR (I1, S2, W1, injection-20) với gate và baseline; Q1 trên golden set với model thật (nightly) |
| `packages/importer` | Import CSV/XLSX: parse (encoding, delimiter, nhiều sheet), mapping theo từ đồng nghĩa, dry-run, commit idempotent, rollback |
| `packages/agents` | `defineTool`, quyền theo role/persona, policy invariants, propose/approve/execute decision (exactly-once) |
| `apps/app` | Hono API: auth (WorkOS access token, API key, dev token); `/v1/users`, `/accounts`, `/contacts`, `/opportunities`, `/suppression`, `/supply-profile`, `/decisions`, `/imports`, `/vertical-packs`, `/playbooks` (+ preview), `/ipps`, `/sourcing-runs`, `/scorecards`, `/contact-lookups`, `/candidates/manual`, `/cards`, `/agents`, `/usage`, `/tenant/kill-switch`, `/notifications` |
| `apps/web` | Next.js UI + BFF: đăng nhập WorkOS (hoặc dev), cookie phiên mã hoá, Decision Inbox (table view, duyệt theo nhóm, card view có phím tắt, undo 5 giây), Setup, Sourcing, Import, Team (mời user, role), Usage, Agents, Notifications; e2e Playwright |
| `apps/worker` | DBOS: outbox dispatcher (đăng ký handler theo topic), workflow chờ quyết định, workflow sourcing run, Q1 qualification, S2 tìm contact, W1 và đề xuất card, playbook preview, queue theo plan (concurrency theo tenant), vòng bảo trì (hết hạn, reservation, escalation, digest, báo usage) |

```bash
cp .env.example .env            # điền ABCRM_DEV_MASTER_KEY: openssl rand -base64 32
docker compose up -d postgres
pnpm install
pnpm db:migrate
psql "$DATABASE_URL" -f packages/db/scripts/dev-roles.sql   # role LOGIN cho local
pnpm dev:app                    # http://localhost:3000/healthz
pnpm dev:worker
pnpm dev:web                    # http://localhost:3001 (đăng nhập dev khi ABCRM_DEV_AUTH=1)

# Test: mỗi file test tự tạo database riêng trên cluster của DATABASE_URL
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
APP_DATABASE_URL=postgres://abcrm_app_user:abcrm_app_pw@localhost:5432/postgres pnpm test

# Eval agent (deterministic; thêm --live để chạy Q1 với model thật)
pnpm eval

# Vận hành (DATABASE_URL = role migrator): tạo tenant, kiểm tra RLS, báo cáo exit criteria
pnpm tenant:create --name "Acme Leads" --slug acme --owner-email owner@acme.vn
pnpm db:rls-check
pnpm report:exit-criteria

# E2E UI (cùng biến môi trường như trên): build rồi chạy Playwright
pnpm --filter @abcrm/web build && pnpm --filter @abcrm/web e2e
```
