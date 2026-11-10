# Runbooks (Phase 1)

Quy trình vận hành cho founder/on-call. Mỗi runbook ghi: khi nào dùng, các bước, cách kiểm tra đã xong.

| Runbook | Khi nào |
|---|---|
| [01 · Deploy và migration](01-deploy.md) | Mỗi lần phát hành; thêm biến môi trường; rollback |
| [02 · Onboard design partner](02-onboarding-design-partner.md) | Tenant mới |
| [03 · Sự cố](03-incidents.md) | Agent chạy sai/tốn credit, provider lỗi, workflow treo, card quá SLA |
| [04 · Backup, restore, khoá](04-backup-restore.md) | Kiểm tra PITR định kỳ; khôi phục dữ liệu; xoay khoá |
| [05 · Yêu cầu về dữ liệu cá nhân](05-data-requests.md) | Opt-out, xoá dữ liệu, đối tác báo contact sai |
| [06 · Bảo mật](06-security.md) | Nghi lộ khoá, user bị lộ tài khoản, nghi rò dữ liệu giữa tenant |

Công cụ dùng chung:
- `pnpm report:exit-criteria [--since YYYY-MM-DD] [--tenant <id>] [--json]`: số liệu exit criteria Phase 1 theo tenant (cần `DATABASE_URL` của role migrator).
- `pnpm tenant:create …`: tạo tenant và owner (xem runbook 02).
- `pnpm db:rls-check`: kiểm tra (chỉ đọc) mọi bảng tenant có FORCE RLS và policy.
- `pnpm eval [--live]`: eval agent (xem test-plan §5).
