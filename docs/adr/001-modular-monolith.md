# ADR-001: Modular monolith

- **Trạng thái:** Accepted (cập nhật v0.2)
- **Bối cảnh:** Solo founder; domain còn thay đổi nhanh; cần ship MVP trong khoảng 3–4 tháng. Microservices làm tăng chi phí vận hành (network, distributed transaction, observability) mà chưa có lợi ích.
- **Quyết định:** Một codebase TypeScript, một Docker image, hai process (`app`, `worker`). Module theo bounded context (`iam`, `leadops`, `crm`, `outreach`, `decisions`, `agents`, `analytics`, `import`, `billing`, `audit`); gọi nhau qua public interface; cấm truy cập bảng của module khác (dependency-cruiser trong CI).
- **Hệ quả:** (+) phát triển nhanh, transaction đơn giản, một người vận hành được. (−) cần kỷ luật ranh giới; nếu tách service sau này phải tách schema.
