# ADR-014: Web sourcing lịch sự, public page cache dùng chung, global contact pressure

- **Trạng thái:** Accepted (D23: founder đồng ý global contact pressure, không chia sẻ dữ liệu giữa tenant)
- **Bối cảnh:** Lead Sourcing Agent (D14) cần đọc web công khai. Nhiều tenant sẽ nghiên cứu **cùng một nhóm buyer** (thị trường buyer US có hạn), gây lãng phí chi phí, tải lên website bên ngoài, và rủi ro **nhiều tenant cùng spam một buyer** (R3). Đồng thời phải giữ cam kết tách biệt dữ liệu tenant.
- **Quyết định:**
  1. **Crawl policy**: chỉ trang công khai; tôn trọng robots.txt (cache); rate limit theo domain **toàn hệ thống**; user-agent định danh và trang liên hệ để chủ website yêu cầu ngừng; no-crawl list (LinkedIn, trang cần đăng nhập); không vượt CAPTCHA/paywall; headless browser chỉ khi cần.
  2. **Public page cache dùng chung** (`public_pages`): khoá theo URL, TTL theo loại trang, **không lưu tenant nào yêu cầu**. Evidence dùng trong scorecard được sao chép vào không gian của tenant.
  3. **Global contact pressure** (`global_contact_pressure`): đếm cold email theo **domain người nhận** trong cửa sổ 7 ngày, khoá bằng HMAC với global key; không có tenant_id hay địa chỉ email. Vượt ngưỡng thì send guard **hoãn** (defer). Tenant chỉ thấy thông báo chung.
  4. Ghi rõ hai cơ chế này trong DPA và tài liệu bảo mật (dữ liệu không thuộc tenant, không thể truy ngược tenant).
- **Phương án đã cân nhắc:** cache theo tenant (tốn gấp nhiều lần, crawl lặp lại cùng site); "buyer graph" chia sẻ thông tin buyer giữa tenant (giá trị cao nhưng vi phạm cam kết tách biệt, nên loại khỏi MVP); không giới hạn tần suất toàn cục (rủi ro uy tín toàn hệ sinh thái).
- **Hệ quả:** (+) giảm chi phí, lịch sự với web, bảo vệ deliverability chung. (−) cần review pháp lý về việc lưu nội dung web (chỉ lưu tối thiểu, có TTL); ngưỡng global pressure cần tinh chỉnh để không làm chậm tenant chính đáng.
