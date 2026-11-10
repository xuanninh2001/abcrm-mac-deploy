# 01 · Deploy và migration

**Cấu hình demo miễn phí:** Render (Oregon) chạy 2 web service Free theo [`render.yaml`](../../render.yaml): `abcrm-api` (Hono), `abcrm-web` (Next.js). Worker DBOS chạy trên máy Windows. Neon Free chứa database ứng dụng và database riêng cho DBOS system. Các dịch vụ có hạn mức miễn phí; Render ngủ khi không hoạt động, không bảo đảm chạy liên tục. Worker dừng khi máy tắt hoặc tiến trình bị đóng.

## Chạy worker trên máy Windows

Từ checkout đã cài dependencies, chạy:

```powershell
powershell.exe -NoProfile -File scripts/start-local-worker.ps1 -SecretsPath "C:\path\to\encrypted-secrets"
```

File secrets là JSON được mã hóa bằng Windows DPAPI qua `ConvertFrom-SecureString`, không phải file dotenv. Chỉ tài khoản Windows đã tạo file mới giải mã được. Đường dẫn mặc định là `.env.production.local` ở thư mục cha của checkout. Không commit secrets. Giữ cửa sổ chạy mở; Ctrl+C để dừng. Chưa cấu hình tự khởi động cùng Windows.

## Lần đầu
1. Neon: tạo project (US), database `abcrm` và `abcrm_dbos`. Kiểm tra giới hạn compute và lịch sử khôi phục của gói Free; cấu hình hiện tại chỉ có lịch sử 6 giờ, chưa đạt yêu cầu PITR 7 ngày cho production.
2. Chạy migration bằng role owner: `DATABASE_URL=… pnpm db:migrate`.
3. Tạo role đăng nhập cho app và worker toàn cục (tương tự `packages/db/scripts/dev-roles.sql`, **đổi mật khẩu**): `abcrm_app_user` (member `abcrm_app`, không BYPASSRLS) và `abcrm_global_user` (member `abcrm_global`).
4. Render secrets: đặt `ABCRM_KEY_PROVIDER=secret`, sinh `ABCRM_MASTER_KEY` bằng `openssl rand -base64 32` và dùng chung cho API/worker. Sao lưu khóa ngoài Render trong kho mật khẩu an toàn; không thay khóa khi redeploy. Dữ liệu vẫn dùng AES-256-GCM với context theo tenant. Phương án này không có sự cách ly khóa và audit CloudTrail của KMS. Nếu cần AWS KMS, chọn `ABCRM_KEY_PROVIDER=kms`, bỏ master key và cấu hình KMS/IAM như trước.
5. Sinh khoá: `openssl rand -base64 32` cho `ABCRM_PLATFORM_HMAC_KEY`, `ABCRM_PLATFORM_CACHE_KEY`, `ABCRM_WEB_SESSION_SECRET`.
6. Render: "New → Blueprint" trỏ tới repo; điền mọi biến `sync: false` trực tiếp ở từng service. Chọn Free; không tạo worker trả phí.
7. WorkOS: redirect URI `https://<web>/auth/callback`; mỗi tenant là một Organization.

## Mỗi lần phát hành
1. PR xanh CI (typecheck, test, eval, build web, e2e) rồi merge vào `main`.
2. Gói Free không chạy `preDeployCommand`. Chạy migration thủ công bằng role owner và kiểm tra RLS trước khi push bản cần schema mới. Render tự build web/API sau push; khởi động lại worker local bằng cùng phiên bản code.
3. Kiểm tra sau deploy:
   - `GET https://<api>/healthz` → `{"ok":true}`.
   - Đăng nhập web, mở Inbox, mở một card.
   - Log worker có dòng khởi động và vòng bảo trì chạy mỗi phút, không lỗi lặp lại.

## Quy tắc migration
- **Chỉ tiến (forward-only).** Không sửa file migration đã chạy ở production; sửa bằng migration mới.
- **Expand → contract:** thêm cột/bảng trước (bản code cũ vẫn chạy được), deploy code dùng cột mới, xoá cái cũ ở lần sau.
- Migration dài (index lớn) dùng `CREATE INDEX CONCURRENTLY` trong file riêng.
- Mọi bảng có `tenant_id` phải gọi `enable_tenant_rls`; CI chặn nếu thiếu (`checkRlsCoverage`).

## Rollback
- Code: khôi phục phiên bản trước cho cả web/API và worker local nếu thay đổi liên quan nhau; tính năng rollback của Render tùy gói đang dùng.
- Schema: không rollback migration. Nếu migration làm hỏng dữ liệu, xem [04 · Restore](04-backup-restore.md).

## Biến môi trường
Danh sách đầy đủ và ý nghĩa: [`.env.example`](../../.env.example). Biến tuỳ chọn để trống thì tính năng tương ứng tắt an toàn: `POSTMARK_SERVER_TOKEN` (chỉ thông báo in-app), `STRIPE_SECRET_KEY` (báo usage `skipped`), `ANTHROPIC_API_KEY` (S1 chỉ rule, tiêu chí AI là unknown), `BRAVE_SEARCH_API_KEY` (không sourcing tự động).
Không bao giờ đặt `ABCRM_DEV_AUTH` hay `ABCRM_WEB_ALLOW_DEV` ở production.
