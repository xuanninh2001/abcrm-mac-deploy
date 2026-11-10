# ADR-004: PostgreSQL + RLS + JSONB; partner scope

- **Trạng thái:** Accepted (cập nhật v0.2)
- **Bối cảnh:** SaaS multi-tenant với yêu cầu tách biệt dữ liệu tuyệt đối; mỗi tenant có partner bên ngoài truy cập Portal; custom field và lead attributes khác nhau theo vertical.
- **Quyết định:**
  - Shared DB / shared schema trong mỗi cell; `tenant_id` mọi bảng; RLS bật trên mọi bảng tenant; app role không có BYPASSRLS; context đặt bằng `set_config(..., true)` trong mỗi transaction (an toàn với pooler ở transaction mode).
  - Partner Portal: thêm `app.partner_id`; Portal chỉ đọc `deliveries.payload_snapshot`, không đọc `leads`.
  - Custom fields và lead attributes: `jsonb` có GIN index; Lead Schema (JSON Schema) theo program.
  - PII: field-level encryption với data key theo tenant và blind index cho tra cứu chính xác.
  - Bảng lớn partition theo tháng.
- **Phương án đã cân nhắc:** schema-per-tenant (khó migrate khi số tenant lớn), DB-per-tenant (đắt, khó vận hành solo; giữ cho Enterprise sau này).
- **Hệ quả:** (+) cô lập nhiều lớp, vận hành đơn giản. (−) cần test cross-tenant tự động; noisy neighbor xử lý bằng per-tenant queue concurrency và rate limit.
