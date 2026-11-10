# 05 · Yêu cầu về dữ liệu cá nhân

ABCRM lưu thông tin liên hệ công việc của người tại công ty buyer (prospect). PII được mã hoá theo tenant; email/domain có blind index để so khớp.

## Opt-out (không liên hệ nữa)
- **Trong một tenant** (rep hoặc buyer yêu cầu agency): rep thêm vào **suppression** (CRM, hoặc import danh sách `blocklist`). Contact bị suppress sẽ huỷ card đang chờ có contact đó. Opt-out pháp lý không gỡ được.
- **Toàn hệ thống** (chủ thể dữ liệu yêu cầu ABCRM, áp dụng mọi tenant và licensed cache): ghi vào global suppression bằng `addGlobalSuppression` (`@abcrm/contactdata`) qua script vận hành. Contact Data Layer sẽ không trả người đó cho bất kỳ tenant nào (INV-8).
- Trang tự phục vụ `/privacy/requests` (api.md §2.8) chưa làm; trong Phase 1 nhận yêu cầu qua email privacy và xử lý tay trong 30 ngày.

## Xoá dữ liệu
1. Xác minh người yêu cầu (trả lời từ chính email đó).
2. Ghi global suppression trước (để dữ liệu không quay lại từ provider).
3. Xoá contact ở các tenant có người đó (theo blind index của email). Bản ghi audit giữ lại nhưng không chứa PII.
4. Trả lời người yêu cầu, lưu ngày xử lý.

## Partner báo contact sai (sai người, đã nghỉ việc)
Rep đánh dấu contact không dùng nữa trong CRM; nếu email bounce/không tồn tại, báo cho provider tương ứng (licensed cache sẽ cập nhật ở lần lookup sau).
