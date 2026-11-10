# ADR-003: Agent hành động qua typed tools với delegated identity

- **Trạng thái:** Accepted (cập nhật v0.2)
- **Bối cảnh:** Agent có thể sai hoặc bị prompt injection qua email/form. Truy cập DB trực tiếp hoặc dùng service account toàn quyền là rủi ro lớn, nhất là khi tenant tạo không giới hạn agent.
- **Quyết định:**
  - Agent chỉ gọi tool trong Tool Registry (Zod schema, `sideEffect`, `gate`, `permission`, `precheck`).
  - Mọi tool chạy với `on_behalf_of` là một **user** hoặc một **service persona** (ví dụ `leadops`) do tenant admin cấp quyền rõ ràng.
  - Quyền hiệu lực = permission của danh tính ∩ tool subset của agent ∩ template ceiling ∩ tenant policy ∩ platform invariants.
  - Tool external chỉ thực thi khi có `decision_id` hợp lệ (ADR-006).
- **Hệ quả:** (+) một mô hình phân quyền cho người, agent, API và MCP; audit đầy đủ. (−) cần UI quản lý service persona; mỗi tool mới phải khai báo metadata đầy đủ.
