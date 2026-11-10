# 06 · Bảo mật

## Nghi lộ khoá hoặc secret
1. Xác định khoá (xem bảng trong [04](04-backup-restore.md#khoá)).
2. Với token dịch vụ: tạo giá trị mới, cập nhật Render và redeploy. Với `ABCRM_MASTER_KEY` hoặc khóa mã hóa/index dữ liệu: không thay trực tiếp; cần quy trình giải mã/bọc lại khóa hoặc mã hóa/index lại dữ liệu, giữ khóa cũ đến khi kiểm chứng hoàn tất. Thay master key trực tiếp sẽ làm dữ liệu cũ không giải mã được.
3. Thu hồi giá trị cũ ở nhà cung cấp (WorkOS, Anthropic, Brave, Postmark, Stripe, AWS).
4. Xem log truy cập trong khoảng nghi ngờ.

## Tài khoản user bị lộ
- Owner/admin: **Team → Disable**. Request kế tiếp của user bị từ chối ngay; card của họ được chia lại.
- WorkOS: thu hồi session của user trong WorkOS dashboard.
- API key lộ: `UPDATE abcrm.api_keys SET revoked_at = now() WHERE key_prefix = '<prefix>'` (migrator; chưa có trang quản lý API key), có hiệu lực ngay ở request kế tiếp.

## Nghi rò dữ liệu giữa tenant
1. Bật kill switch cho tenant liên quan; nếu nghiêm trọng, `status = 'suspended'`.
2. Chạy `DATABASE_URL=<migrator> pnpm db:rls-check` trên production (chỉ đọc). **Không** chạy `rls_smoke_test.sql` ở production: script đó tạo role và dữ liệu thử.
3. Tìm trong `audit_log` các thao tác của actor liên quan.
4. Thông báo tenant bị ảnh hưởng theo hợp đồng; ghi post-mortem.

## Prompt injection
- Text ẩn trên trang (display:none, hidden, aria-hidden, chữ cỡ 0, đẩy ra ngoài màn hình) bị bỏ trước khi đến S1/Q1.
- Quote chỉ được tính là bằng chứng khi khớp nguyên văn với trang (ADR-013); card không bao giờ hiện quote chưa kiểm chứng.
- Thấy `injection_suspected` trên scorecard: kiểm tra trang nguồn; thêm domain vào `crawl_policy` deny nếu là trang độc hại.
- Bộ eval `injection-20` chạy trong CI ở mọi PR.
