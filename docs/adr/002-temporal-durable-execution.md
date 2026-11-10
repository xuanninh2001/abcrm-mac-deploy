# ADR-002: Temporal làm durable execution cho agent

- **Trạng thái:** **Superseded by [ADR-009](./009-durable-execution-dbos.md)** (2026-10-24)
- **Lý do thay thế:** Với solo founder và yêu cầu data residency theo cell, việc vận hành thêm Temporal (self-host hoặc Cloud) không xứng với chi phí. DBOS chạy trên chính Postgres của cell, đáp ứng cùng nhu cầu (durable steps, chờ approval, retry, queue).

---
*Nội dung gốc:* Mỗi agent run là một Temporal workflow; LLM/tool call là activity; approval là signal; hết hạn là timer.
