# ADR-016: Intent Signals từ nguồn hợp lệ, không truy cập tự động LinkedIn

- **Trạng thái:** Proposed (D27 đã được founder đồng ý; chi tiết nguồn chờ kết quả phỏng vấn)
- **Bối cảnh:** Buyer thường đăng công khai nhu cầu tìm publisher/media buyer ("need affiliates for offer X in vertical Y"). Đây là tín hiệu mạnh nhất cho sourcing. Nhiều tín hiệu nằm trên LinkedIn, nhưng ToS của LinkedIn cấm scrape và truy cập tự động; API chính thức không cho bên thứ ba tìm bài đăng theo từ khoá; LinkedIn đã kiện nhiều bên cung cấp dữ liệu; tài khoản của rep có thể bị khoá.
- **Quyết định:**
  - Module `signals` với **Signal Monitor** (từ khoá, vertical, nguồn, lịch quét) và interface `SignalSource` có allowlist adapter: `search_index`, `jobs`, `offer_dirs`, `reddit`, `manual`; sau này `x`, `telegram_public`.
  - **LinkedIn**: không fetch, không automation, không extension đọc nền. Chỉ dùng **title, snippet và URL do web search API trả về**, hoặc nội dung **rep tự gửi vào** (paste, forward email, nút "Save to ABCRM" chỉ khi rep chủ động bấm). Fetcher giữ LinkedIn trong no-crawl list (ADR-014).
  - Không đọc nhóm, diễn đàn hay kênh cần đăng nhập.
  - Classifier (tier small) phân biệt `buyer_seeking_supply` với `publisher_seeking_buyers`; chỉ bật fast-track khi precision trên eval ≥ 90%.
  - Tín hiệu khớp sẽ **fast-track** qua qualification thành card G-Q làn `hot-intent`. **Không có ngoại lệ với G-Q**: rep vẫn duyệt trước khi liên hệ.
  - Freshness decay, mặc định hết hạn 14 ngày; giới hạn tần suất theo tín hiệu (48h) cộng với global contact pressure (D23).
  - Signals là dữ liệu của tenant; tác giả bài đăng là dữ liệu cá nhân: mã hoá, lưu nguồn, áp dụng DSAR và suppression.
- **Phương án đã cân nhắc:**
  - Scrape LinkedIn hoặc dùng vendor dữ liệu LinkedIn: rủi ro pháp lý, rủi ro khoá tài khoản, rủi ro vendor bị đóng cửa. **Loại.**
  - Extension tự đọc feed LinkedIn của rep: vi phạm ToS, rủi ro tài khoản. **Loại.**
  - Chỉ làm manual capture: an toàn nhưng phụ thuộc rep; giữ làm một adapter, không phải toàn bộ giải pháp.
- **Hệ quả:** (+) nguồn candidate chất lượng cao, email cá nhân hoá theo nhu cầu thật, lợi thế bán hàng. (−) độ phủ LinkedIn thấp hơn so với scrape; phụ thuộc chất lượng search API và độ trễ index; cần eval riêng và theo dõi adapter.
