# 04 · Backup, restore, khoá

## PITR (Neon)
Neon giữ WAL theo thời hạn đã cấu hình (≥ 7 ngày). Restore = tạo **branch** tại một thời điểm.

**Kiểm tra định kỳ (mỗi tháng; Phase 0 exit criterion "PITR được kiểm tra"):**
1. Neon → Branches → New branch from `main` tại thời điểm cách đây 1 giờ.
2. Chạy kiểm tra trên branch (connection string của branch, role owner):
   ```bash
   DATABASE_URL=<branch> pnpm db:migrate              # phải in "up to date"
   DATABASE_URL=<branch> pnpm db:rls-check            # chỉ đọc: RLS phủ đủ mọi bảng tenant
   DATABASE_URL=<branch> pnpm report:exit-criteria    # chạy được, số liệu hợp lý
   ```
3. Ghi kết quả (ngày, thời điểm restore, thời gian thực hiện) vào nhật ký vận hành; xoá branch.

## Restore thật
1. Bật kill switch cho các tenant bị ảnh hưởng (hoặc scale worker về 0) để không có ghi mới.
2. Tạo branch tại thời điểm trước sự cố; kiểm tra dữ liệu trên branch.
3. Chọn: (a) chuyển connection string của app/worker sang branch, hoặc (b) chỉ copy các bảng/dòng bị hỏng từ branch về `main`.
4. DBOS system database restore cùng thời điểm nếu chuyển cả hệ thống (workflow đang chờ decision sẽ resume theo trạng thái DB thật).
5. Tắt kill switch; theo dõi log worker 30 phút.

## Khoá
| Khoá | Mất khoá thì | Xoay khoá |
|---|---|---|
| `ABCRM_MASTER_KEY` (Render secret, bọc data key từng tenant) | **Mất toàn bộ PII đã mã hóa.** Sao lưu ngoài Render; dùng cùng giá trị cho API/worker | Chưa có công cụ xoay tự động. Phải bọc lại mọi tenant key bằng khóa mới và kiểm chứng trước khi đổi secret; không đổi trực tiếp |
| AWS KMS key (bọc data key từng tenant) | **Mất toàn bộ PII đã mã hoá.** Không xoá key; bật deletion protection | Thêm key version mới trong KMS; data key cũ vẫn mở được |
| `ABCRM_PLATFORM_HMAC_KEY` / `ABCRM_PLATFORM_CACHE_KEY` | Không tra được global suppression và licensed cache | Chưa hỗ trợ xoay (cần migration tính lại blind index) |
| `ABCRM_WEB_SESSION_SECRET` | Mọi người bị đăng xuất | Đổi giá trị, redeploy web |
| WorkOS API key | Không gửi lời mời, user mới không kích hoạt được | Tạo key mới trong WorkOS, cập nhật API và web, thu hồi key cũ |

Lưu các khoá trong password manager có 2 người giữ; không lưu trong repo.
