# ADR-007: Usage metering bằng Agent Credits và Stripe Meters

- **Trạng thái:** Accepted (D12: đề xuất bị từ chối vẫn tính credit; credit ghi khi decision được tạo)
- **Bối cảnh:** Giá = seat + volume hành động agent; không giới hạn số agent; overage theo plan. Chi phí thực khác nhau theo loại hành động.
- **Cập nhật v0.5 (D21, D22):** thêm meter thứ hai **Contact Credits** (mỗi contact có email verified do ABCRM cung cấp, chỉ tính khi có kết quả); `usage_balances` và spend cap theo từng meter; internal cost ledger theo dõi chi phí thực (LLM, search, provider) để đo margin. Seat rẻ, included credits tính theo tenant.
- **Cập nhật v0.8 (D28):** so sánh "giới hạn số agent theo plan" với "không giới hạn agent, cap volume"; **giữ cap volume** vì chi phí đi theo hành động, sản phẩm cần agent chuyên biệt, và giới hạn số agent dễ lách. Điểm yếu (khó hình dung, sợ phát sinh) được khắc phục bằng:
  - Quy đổi credit ra **buyer cards/tháng** trên trang pricing.
  - Spend cap mặc định: Starter hard stop; Growth+ cap = 50% giá plan.
  - Cảnh báo ở mức 50/80/100%; credit packs trả trước.
  - Thang upsell theo **năng lực** (template mở theo plan).
  - **Guardrails theo agent**: ngân sách ngày/tháng tuỳ chọn, anomaly alert (> 3× thì cảnh báo, > 5× thì auto-pause), circuit breaker khi acceptance rate thấp.
  - Giới hạn **công suất** (concurrency, Signal Monitors đang chạy, mailbox, tần suất poll), không giới hạn số agent tạo ra.
- **Quyết định:**
  - Đơn vị **Agent Credit** có trọng số theo loại hành động (xem `04-pricing-and-metering.md`).
  - `usage_events` append-only, idempotency key theo `run:step:action`, ghi cùng transaction với hành động.
  - `usage_balances` reserve atomic trước hành động; spend cap; pause khi hết (trừ compliance actions).
  - Job hằng giờ đẩy aggregate (không PII) sang Stripe Meters; reconcile hằng ngày.
  - Giới hạn bảo vệ hạ tầng bằng **concurrency theo plan**, không giới hạn số agent.
- **Phương án đã cân nhắc:** tính theo token (khó hiểu với khách, lộ chi phí nội bộ); tính theo số agent (trái với D4); dùng nền tảng metering bên thứ ba như Orb/Metronome (mạnh nhưng thêm vendor; cân nhắc lại khi pricing phức tạp hơn).
- **Hệ quả:** (+) khách dễ hiểu, kiểm soát margin. (−) phải tự viết và test kỹ phần metering vì sai là mất tiền hoặc mất niềm tin.
