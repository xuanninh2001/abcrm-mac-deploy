# 02 · Onboard design partner

Mục tiêu tuần đầu: partner duyệt những card thật đầu tiên. Exit criteria Phase 1 đo trên 3 partner.

1. **WorkOS:** tạo Organization cho agency, ghi lại `org_…`.
2. **Tạo tenant** (máy có `DATABASE_URL` migrator):
   ```bash
   pnpm tenant:create --name "Acme Leads" --slug acme --country VN --plan trial \
     --workos-org org_… --owner-email owner@acme.vn --owner-name "Tên owner"
   ```
   Owner ở trạng thái `invited`. Mời owner vào Organization trên WorkOS; lần đăng nhập đầu tiên (email đã xác minh trùng) kích hoạt tài khoản.
3. **Owner mời team** ở trang **Team**: head of BD, sales rep. Mỗi người tự đặt timezone và giờ làm việc (SLA card tính theo đó).
4. **Supply Profile** (Setup): lead type, bang, consent/TrustedForm, nguồn traffic → head of BD gửi duyệt G-T1.
5. **Clone pack** (Setup): Insurance, Finance hoặc Home Services; chỉnh playbook theo partner, chạy **preview** trên mẫu, rồi gửi duyệt G-T1 cho playbook và IPP.
6. **Import** (trang Import, owner/admin):
   - `existing_buyers`: buyer đang làm việc, để sourcing không đề xuất lại.
   - `blocklist`: email/domain không được liên hệ.
   - Có thể import accounts/contacts từ CRM cũ. Luôn xem dry-run trước khi commit.
7. **Sourcing run đầu tiên nhỏ** (≤ 50 candidate) để kiểm tra chất lượng; xem chi phí ước tính trước khi chạy.
8. **Theo dõi tuần đầu:**
   - Card xuất hiện trong Inbox; rep duyệt và reject có lý do.
   - Lý do reject lặp lại → chỉnh playbook (version mới qua G-T1).
   - Trang Usage: credit dùng/còn; đặt spend cap nếu cần.
9. **Hằng tuần:** `pnpm report:exit-criteria --tenant <id>`; gửi partner tóm tắt (số card, tỉ lệ duyệt Tier A, thời gian duyệt).

Plan và hạn mức: tenant mới dùng `trial` (1000 Agent Credit, 50 Contact Credit, hard stop). Đổi plan: `UPDATE abcrm.tenants SET plan = 'starter' WHERE id = …` (migrator), số dư kỳ sau theo plan mới.
