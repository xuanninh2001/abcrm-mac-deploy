# Aurora: giao diện theo nhận diện DB Media Groups

## Phân tích nguồn tham chiếu

Đã khảo sát trực tiếp https://dbmediagroups.com/ ngày 11/11/2026 bằng Chrome:

| Yếu tố | Website DBMG | Áp dụng vào Aurora |
|---|---|---|
| Màu thương hiệu | Cam `#FF5733` | Điểm nhấn, biểu tượng workspace, trạng thái điều hướng |
| Màu nền | Xám than `#333333`, trắng ngà `#F5F6F5` | Sidebar than, vùng làm việc sáng, nền bảng trung tính |
| Typography | Montserrat cho tiêu đề, Open Sans cho nội dung | Cùng hai họ chữ, kích thước nhỏ hơn phù hợp dữ liệu CRM |
| Logo | Khối lập phương + DBMG | Logo local, sửa viewBox để chữ G không bị cắt như SVG nguồn |
| Bố cục | Các khối nội dung rộng, khoảng thở lớn, tiêu đề nổi bật | Nhóm điều hướng rõ, tiêu đề trang và mô tả ngắn, bảng dễ quét |
| Chuyển động | Nội dung/tiêu đề xuất hiện động | Form xuất hiện nhẹ, menu mobile trượt; hỗ trợ reduced motion |

Website giới thiệu doanh nghiệp có nhiều đoạn nội dung và tiêu đề lớn. Aurora chỉ kế thừa nhận diện: các màn hình nghiệp vụ dành không gian cho form, dữ liệu và thao tác. Không đưa carousel hoặc nội dung quảng cáo vào trang làm việc.

## Hệ thống giao diện

- `globals.css`: nền tảng chung hiện có; `brand.css`: token thương hiệu, bố cục, component và responsive.
- `AppShell`: sidebar theo quyền, trạng thái trang hiện tại kể cả editor con, breadcrumb, thông báo, tài khoản và đăng xuất.
- Mobile: menu đóng/mở, Escape, giữ focus trong menu, trả focus về nút mở, khóa nền khi menu mở. Tài khoản và đăng xuất vẫn truy cập được.
- `PageHeading`: tiêu đề/mô tả thống nhất cho Setup, Sourcing, Agents, Import, Usage, Team, Notifications và mật khẩu.
- `PasswordInput`: hiện/ẩn mật khẩu, nút không submit form. Giữ autocomplete, validation và tên trường server.
- Inbox: tổng số card, Tier A và SLA dùng dữ liệu thật; filter có trạng thái; shortcut thu gọn; trạng thái rỗng và kết quả bulk vẫn hiển thị.
- Bảng cuộn riêng bằng chuột, touch hoặc bàn phím; không ẩn cột để vừa mobile.
- Nút, field, badge, cảnh báo, đoạn AI, bằng chứng và toast dùng hệ token chung.

Cam thương hiệu trên nền trắng chỉ đạt 3,15:1. Nút có chữ trắng dùng `#B93619` (5,83:1); chữ phụ `#626A6D` trên nền `#F5F6F5` đạt 5,10:1. Không dùng riêng màu sắc để thay nhãn trạng thái.

Logo và bốn font được phục vụ từ `apps/web/public/brand`, không gọi Google Fonts lúc build/chạy. Giấy phép OFL đi kèm. Logo lấy từ URL công khai của website DBMG; chỉ điều chỉnh khung nhìn để hiển thị đủ chữ.

## Phạm vi chức năng

Giữ các endpoint, database, quyền backend, session và schema. Các thao tác duyệt/reject/snooze/reassign, undo/phím tắt, bulk approve, sourcing, playbook/IPP, import/dry-run/rollback, budget/kill switch, phân quyền Team, thông báo và mật khẩu tiếp tục dùng component/handler hiện có. Import vẫn chỉ hiện với owner/admin. Không có số liệu demo trong code sản phẩm.

Không tự push hoặc triển khai bản giao diện. Mac cần nhận source mới, build image web và recreate web sau khi kiểm tra/chấp nhận bản sửa. Không cần migration database cho thay đổi thiết kế này.

## Kiểm chứng và giới hạn

- TypeScript web và cấu hình e2e: đạt.
- Build production Next.js: đạt.
- 38 kiểm thử web: đạt, gồm session/CSRF, undo queue, xử lý text và kiểm tra điều hướng theo 5 role.
- Đã kiểm tra trực quan render từ component thật ở desktop và mobile: login, Inbox, bảng có dữ liệu; kiểm tra tràn ngang và logo. Preview dùng database thử riêng, không chạm dữ liệu Mac.
- Preview HTML tĩnh chỉ kiểm chứng hình thức, không thay thế kiểm thử tương tác end-to-end.
- Lệnh khởi động Next.js local bị bộ duyệt tự động chặn với `blocked by policy`, kể cả bind loopback. Vì vậy chưa xác nhận lại thao tác E2E trên giao diện mới trong lượt này; không tuyên bố đã kiểm thử toàn bộ tính năng trên Mac.

Khi chạy được server thử, cần xác nhận: đăng nhập/hiện mật khẩu; mở/đóng menu mobile bằng click/Escape/Tab; chuyển trang đúng quyền; duyệt/undo/bulk/reject/snooze; tạo user và disable; import CSV/mapping/dry-run/commit/rollback; lưu profile; đổi mật khẩu và đăng xuất. Dùng database thử, không thực hiện mutation QA trên dữ liệu production.

Các ảnh kiểm tra local nằm trong `output/playwright/` (không đưa vào Git hoặc Docker).
