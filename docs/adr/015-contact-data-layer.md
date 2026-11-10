# ADR-015: Contact Data Layer: ABCRM cung cấp contact data trong credit

- **Trạng thái:** Proposed
- **Bối cảnh:** Founder chốt ABCRM cung cấp contact data cho tenant (D21) thay vì tenant tự mua (BYO key). Chức danh cần tìm (affiliate, partnerships, media buying manager tại lead buyer) là ngách, nên một provider đơn lẻ thường phủ thấp. Giá dữ liệu cao và biến động. License của provider khác nhau (resale, cache, lưu trữ). Khi cung cấp dữ liệu cá nhân, ABCRM có thể bị coi là data broker ở một số bang US.
- **Quyết định:**
  - Module `contactdata` với **waterfall** 2–3 provider (rẻ trước, đắt sau), dừng khi đủ contact khớp title; title matching bằng rule kết hợp LLM small.
  - **License policy là cấu hình** theo provider (`resale_ok`, `cache_scope: none|tenant|global`, `ttl_days`, attribution); code bắt buộc tuân theo; provider không cho resale thì không được bật.
  - **Licensed contact cache** dùng chung chỉ khi license cho phép; không ghi tenant đã tra cứu; contact được sao chép vào không gian tenant khi cấp.
  - **Pay-on-result**: Contact Credit chỉ tính cho contact có email verified; reserve theo `limit`, commit theo kết quả.
  - **Tìm contact sau knockout** để không tốn tiền dữ liệu cho công ty bị loại.
  - **Global data suppression** cho yêu cầu opt-out/xoá gửi tới ABCRM; không bao giờ cấp lại cho bất kỳ tenant nào; lan sang contact đã cấp (dừng sequence).
  - **Phạm vi dữ liệu MVP (D26):** email verified và LinkedIn profile URL nếu provider có; **không** cung cấp số điện thoại. ABCRM không scrape LinkedIn; URL chỉ đến từ provider hoặc từ file tenant import, dùng cho manual-channel tasks.
  - Lưu `source` (provider, thời điểm, license ref) cho mỗi contact; internal cost ledger theo provider.
- **Phương án đã cân nhắc:** BYO key (đơn giản, không rủi ro pháp lý, nhưng founder chọn không làm vì rào cản với agency offshore; có thể giữ làm tuỳ chọn cho plan cao); tự xây database contact (không khả thi cho solo founder, rủi ro pháp lý cao).
- **Rủi ro & giảm thiểu:**
  - Margin: đo trên golden set trước khi ký; Contact Credits có giá riêng.
  - Data broker: luật sư đánh giá đăng ký và xử lý yêu cầu xoá tập trung trước launch.
  - Phụ thuộc provider: dùng adapter và waterfall.
- **Hệ quả:** (+) trải nghiệm trọn gói cho agency, doanh thu credit lớn hơn, cache dùng chung là lợi thế chi phí. (−) thêm nghĩa vụ pháp lý và quản lý vendor; chi phí biến đổi lớn cần giám sát hằng ngày.
