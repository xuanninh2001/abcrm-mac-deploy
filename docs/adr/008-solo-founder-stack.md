# ADR-008: Tech stack cho solo founder

- **Trạng thái:** Accepted
- **Bối cảnh:** Một người xây và vận hành; cần tốc độ, ít thành phần, managed; US-first (EU sau, cần giữ khả năng thêm region); nhiều tích hợp; agent dùng LLM.
- **Quyết định:**
  - **TypeScript end-to-end** (Node 22 LTS), pnpm + Turborepo.
  - Next.js (UI, Partner Portal), Hono và zod-openapi (API), Drizzle (SQL), Zod (schema chung).
  - PostgreSQL managed (Neon; pgvector, PITR, branching), **DBOS** cho workflow/queue (ADR-009).
  - Render (compute, US; có region EU khi cần), Cloudflare R2 (object storage), WorkOS (auth/SSO), Stripe (billing), Postmark/SES (email hệ thống), Sentry, OTel (Grafana Cloud/Axiom), Langfuse, PostHog.
  - **Không dùng trong MVP:** Kafka, Temporal, Redis, OpenSearch, ClickHouse, Kubernetes. Mỗi thứ chỉ thêm vào bằng một ADR khi có số liệu chứng minh cần.
- **Phương án đã cân nhắc:** Python cho agent (hai ngôn ngữ thì tăng gánh nặng cho một người); Supabase all-in-one (auth multi-org và SSO kém linh hoạt hơn WorkOS; vẫn có thể dùng làm Postgres); AWS thuần (linh hoạt nhưng tốn công vận hành).
- **Hệ quả:** (+) một người có thể hiểu và vận hành toàn hệ thống; AI coding tool hiệu quả. (−) phụ thuộc vài vendor; giảm thiểu bằng abstraction mỏng ở auth, LLM, storage.
