# ADR-009: Durable execution trên Postgres (DBOS)

- **Trạng thái:** Proposed (thay thế ADR-002)
- **Bối cảnh:** Agent run nhiều bước, chờ người duyệt hàng giờ đến hàng ngày; delivery có retry; sequence có lịch; import chạy lâu. Cần resume khi worker restart, exactly-once cho side effect, queue có giới hạn concurrency theo tenant. Dữ liệu (kể cả trạng thái workflow chứa PII) phải nằm trong cell.
- **Quyết định:** Dùng **DBOS Transact (TypeScript)**: workflow và step được checkpoint vào Postgres của cell; `recv/send` cho approval; queue với concurrency và rate limit; scheduled workflows cho cron. LLM call và tool call là step.
- **Phương án đã cân nhắc:**
  - *Temporal* (Cloud hoặc self-host): trưởng thành nhất, nhưng thêm hệ thống hoặc vendor, chi phí, và residency cần chọn region Cloud.
  - *Inngest*: DX tốt, có concurrency/throttle theo key, nhưng event và step output nằm trên hạ tầng của vendor (residency), trừ khi chỉ truyền ID.
  - *pg-boss/graphile-worker* và tự viết state machine: đơn giản nhưng phải tự giải quyết durable multi-step và resume.
- **Rủi ro & giảm thiểu:** hệ sinh thái nhỏ hơn Temporal, nên bọc trong interface `WorkflowEngine` mỏng (start, step, waitForSignal, sleep, enqueue) để có thể đổi engine; spike Phase 0 kiểm chứng chờ approval nhiều ngày, restart và tải 200 lead/s.
- **Hệ quả:** (+) không thêm hạ tầng; transaction và workflow cùng một DB; residency tự nhiên. (−) tải workflow cộng vào Postgres chính, nên theo dõi và tách DB riêng cho DBOS state nếu cần.
