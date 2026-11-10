# ADR-012: Outbound qua mailbox của tenant, Send Guard và auto-pause

- **Trạng thái:** Proposed
- **Bối cảnh:** Outreach tới lead buyers tại US là kênh chính (D13). Deliverability quyết định sống còn: một tenant gửi spam có thể làm hỏng uy tín hạ tầng chung; Google, Yahoo và Microsoft siết yêu cầu với sender; CAN-SPAM bắt buộc opt-out. Mọi email phải có phê duyệt hợp lệ (D5).
- **Quyết định:**
  - Cold outreach **chỉ gửi qua mailbox của tenant** (Google Workspace qua Gmail API, Microsoft 365 qua Graph), kết nối OAuth. ABCRM **không vận hành IP hoặc ESP chung** cho cold email; ESP chỉ dùng cho email hệ thống.
  - **Send Guard** là platform invariant chạy ngay trước mỗi lần gửi: **G-Q approved** cho contact, approval nội dung hợp lệ (G-OUT hoặc deterministic pre-approval), suppression, geo US-only, giờ gửi theo TZ người nhận, giới hạn và ramp của mailbox, sức khoẻ domain (SPF/DKIM/DMARC), trạng thái sequence, footer và List-Unsubscribe, content rules theo vertical.
  - **Auto-pause** mailbox/campaign khi vượt ngưỡng bounce hoặc complaint; mở lại cần decision.
  - Mặc định không dùng open pixel và link tracking.
  - Warmup dùng dịch vụ bên ngoài (tuỳ chọn), không tự xây.
- **Phương án đã cân nhắc:** Hạ tầng SMTP/IP riêng (rủi ro uy tín chéo tenant, vận hành nặng); tích hợp làm "lớp điều khiển" cho Instantly/Smartlead (nhanh hơn nhưng mất kiểm soát send guard và gates; có thể là adapter sau này).
- **Rủi ro:** Google OAuth verification cho restricted scopes (thời gian, chi phí assessment); thay đổi chính sách provider với cold outreach. Giảm thiểu: nộp sớm, scope tối thiểu, provider adapter có thể thêm SMTP/IMAP.
- **Hệ quả:** (+) cô lập rủi ro theo tenant, kiểm soát tuyệt đối việc gửi. (−) phụ thuộc quota mailbox của provider; cần nhiều mailbox cho volume lớn (đúng với thực tế ngành).
