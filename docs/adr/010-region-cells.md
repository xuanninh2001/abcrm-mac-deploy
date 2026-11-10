# ADR-010: Region cells (US / EU) cho data residency

- **Trạng thái:** **Deferred** (2026-10-24, D10: tập trung US trước). MVP chạy một cell `us`; giữ `tenant.region` và tránh giả định single-region trong code để bật EU sau.
- **Bối cảnh:** Thị trường US/EU; khách EU thường yêu cầu dữ liệu ở EU (GDPR, hợp đồng); cần tách biệt dữ liệu và giới hạn blast radius.
- **Quyết định:**
  - Mỗi region là một **cell** độc lập (app, worker, Postgres, bucket, LLM endpoint, Langfuse) với cùng codebase.
  - Global control plane tối thiểu: tenant directory (tenant → region), WorkOS, Stripe; **không chứa PII của lead**.
  - Tenant chọn region khi tạo và không đổi (đổi region là migration có hỗ trợ, thủ công).
  - Launch với `us`; `eu` bật ở Phase 3 hoặc khi có khách EU trả tiền.
- **Hệ quả:** (+) residency rõ ràng, sự cố ở một cell không ảnh hưởng cell khác. (−) gấp đôi chi phí và công vận hành khi bật EU; không báo cáo xuyên cell (chấp nhận được vì tenant chỉ ở một cell).
