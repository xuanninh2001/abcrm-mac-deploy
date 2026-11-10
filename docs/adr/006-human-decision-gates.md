# ADR-006: Human Decision Gates là platform invariant

- **Trạng thái:** Accepted (cập nhật v0.4: thêm G-Q)
- **Bối cảnh:** Founder yêu cầu (D5): mọi tin gửi ra ngoài và mọi quyết định then chốt ở TOFU/MOFU/BOFU phải có người review và phê duyệt. Outbound lead gen tại US có rủi ro pháp lý cao (CAN-SPAM, CCPA, TCPA khi partner gọi, licensing theo vertical). Tenant tạo được không giới hạn agent.
- **Quyết định:**
  - `Decision` là entity hạng nhất (gate_id, action, evidence, content_hash, status, decided_by…).
  - Platform gates (G-OUT, G-T1..T3, G-M1..M2, G-B1..B4) được định nghĩa trong code; **không có cấu hình nào ở plan, tenant hay agent tắt được**. Tenant chỉ thêm gate.
  - Tool có `sideEffect=external` hoặc thuộc nhóm key decision chỉ thực thi khi có decision `approved`, khớp tenant và `content_hash` (hoặc `final_action` nếu người duyệt đã sửa), exactly-once.
  - Re-check điều kiện (suppression, consent scope, cap, quiet hours) **lúc thực thi**.
  - Ngoại lệ một chiều: opt-out, unsubscribe và DSAR luôn tự động (bảo vệ chủ thể dữ liệu, không bao giờ gây hại).
  - Grouped review (**đã chốt D8**): một thao tác của người duyệt có thể phê duyệt nhiều decision; mỗi decision có bản ghi phê duyệt riêng.
  - Combined card: nhiều gate trên cùng subject (ví dụ G-M1 + G-B1 + G-OUT intro) được duyệt trong một thao tác, ghi approval cho từng decision trong một transaction.
  - **Chế độ duyệt (Q7, đã chốt D18: deterministic merge = đã duyệt):** *Strict*: mọi email qua G-OUT. *Deterministic merge*: email được xác định hoàn toàn bởi template đã duyệt (G-T2, không có `ai_slots`) và dòng list đã duyệt (G-T1), có preview đầy đủ, được coi là đã phê duyệt; mọi nội dung do AI viết vẫn qua G-OUT. Chế độ này cấu hình ở **cấp platform**, tenant không tự hạ được.
  - Invariants bổ sung: geo US-only; deliverability auto-pause luôn được phép (hành động bảo vệ). *(Các invariant về handoff consent và partner license ở v0.3 không còn áp dụng do D13.)*
  - **v0.4, G-Q "Approve to Contact" (D16):** không có tool outreach nào (enroll, send, reply, manual task) chạy trên contact/account chưa có G-Q `approved` do **Sales Rep** duyệt. Áp dụng cả cho contact import và contact được giới thiệu trong reply ("talk to my colleague"). Card G-Q gộp G-OUT của email đầu tiên.
  - Gate set v0.4: G-T1 (IPP/Playbook/Supply/sourcing run lớn), G-T2 (sequence), G-Q, G-OUT, G-M1/M2 (opportunity), G-B1 (terms), G-B2 (won/lost). Các gate giao lead/return của v0.3 bị loại vì ABCRM không giao consumer lead (D13).
- **Kiểm chứng:** unit test và property-based test cho policy engine; test e2e cố gọi tool external không qua decision phải thất bại; audit log hash chain.
- **Hệ quả:** (+) an toàn pháp lý, niềm tin, điểm bán hàng (human oversight). (−) con người thành nút thắt, nên Decision Inbox, SLA, grouping và reviewer seat là đầu tư bắt buộc.
