# Sources / Nguồn dữ liệu

Owner mở `/sources` để cấu hình nguồn tìm kiếm và nguồn contact riêng.

## Provider đã triển khai

| Provider | Vai trò | Kiểm tra kết nối |
|---|---|---|
| Brave Search | Tìm website doanh nghiệp | Một truy vấn tìm kiếm nhỏ |
| Tavily Search | Nguồn tìm kiếm bổ sung hoặc dự phòng | Một truy vấn basic |
| Hunter Domain Search | Tìm contact theo domain doanh nghiệp | Kiểm tra tài khoản bằng `/v2/account` |

Tham chiếu API: [Brave](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started),
[Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search),
[Hunter](https://hunter.io/api-documentation/v2).

Endpoint được cố định trong adapter. Không nhập URL 9router tại trang Sources:
9router là cấu hình LLM, không phải nguồn dữ liệu trong bản tích hợp này.

## Cách sử dụng

1. Nhập API key của provider. Để trống key nếu muốn giữ key đã lưu.
2. Bấm **Test connection**. Test không lưu cấu hình và không nhập contact vào CRM.
   Search test có thể tiêu quota. Hunter test chỉ xác nhận tài khoản, chưa xác nhận
   quyền dùng Domain Search hoặc khả năng tìm contact của domain cụ thể.
3. Bật nguồn, chọn priority cho tìm kiếm (số nhỏ chạy trước), rồi **Save source**.
4. Với Hunter, xác nhận hợp đồng/gói dịch vụ cho phép nhập và dùng contact trong CRM.
5. Muốn tắt: bỏ chọn Enable và Save. Muốn xóa key: tắt nguồn, chọn Remove key rồi Save.

Mỗi provider được lưu riêng. Trạng thái Unsaved chưa áp dụng vào worker.
Các workflow mới đọc cấu hình theo workspace, không cần restart sau mỗi lần đổi key.
Tác vụ đang chạy có thể tiếp tục dùng cấu hình đã đọc trước đó.

Khi nguồn tìm kiếm lỗi, thử nguồn bật tiếp theo theo priority. Khi trả về kết quả
hợp lệ nhưng rỗng, không gọi nguồn tiếp theo. Nếu mọi nguồn đều lỗi, báo lỗi rõ ràng.

Nếu chưa từng lưu nguồn search trong workspace, worker giữ fallback
`BRAVE_SEARCH_API_KEY` từ môi trường. Sau khi lưu bất kỳ nguồn search nào, chỉ dùng
các nguồn search bật trong workspace. Tắt hết nguồn không khôi phục fallback môi
trường. Cấu hình Hunter không ảnh hưởng fallback search.

## Contact và bảo vệ dữ liệu

- Key mã hóa bằng keyring theo tenant, có FORCE RLS; API chỉ trả `hasApiKey`.
- Chỉ owner đọc, sửa hoặc test nguồn; không gửi key đã lưu xuống trình duyệt.
- Hunter dùng `type=personal`, chỉ giữ email có `verification.status=valid`.
  Bỏ qua email unknown/catch-all/invalid và contact thiếu tên/chức danh.
- Không nhập số điện thoại, không tự đoán email, không tự gửi email.
- Title matching, suppression theo tenant/toàn hệ thống, quota và idempotency của
  lookup tiếp tục áp dụng. Kiểm tra budget trước khi tạo contact để tránh ghi thêm
  contact ngoài ngân sách.
- Contact lấy bằng key riêng của workspace không vào cache contact dùng chung.
  Cấu hình tenant không sửa registry license toàn nền tảng.
- Kết quả tìm kiếm bằng key riêng không dùng cache tìm kiếm toàn nền tảng.
- Phí provider và credit nội bộ là hai khoản riêng. Chưa quy đổi phí gói provider
  sang USD trong cost ledger; số 0 không có nghĩa request miễn phí.
- Request giới hạn 20 giây, response 2 MiB, không theo redirect; không đưa upstream
  response body hoặc URL chứa Hunter key vào lỗi/log ứng dụng.

## Cập nhật Mac

Bản này có migration `0014_source_settings.sql`, thay đổi API, worker và web.
Sau khi source được push và pull về, trong thư mục có `.env.docker.local`:

```bash
docker compose --env-file .env.docker.local -f compose.production.yaml build api web
docker compose --env-file .env.docker.local -f compose.production.yaml run --rm --no-deps migrate
docker compose --env-file .env.docker.local -f compose.production.yaml up -d --no-deps --force-recreate api worker web
docker compose --env-file .env.docker.local -f compose.production.yaml ps
```

Chỉ tiếp tục khi lệnh trước thành công; PostgreSQL cần đang chạy. Runtime image
của API cũng được dùng bởi worker và migrate. Không xóa volume dữ liệu. Nên có
backup PostgreSQL trước migration và cập nhật khi không có tác vụ đang chạy.

## Kiểm chứng

Kiểm thử adapter với response giả lập; API/worker/migration dùng PostgreSQL thử
riêng để xác nhận RLS, encryption, bật/tắt, fallback, consent và lookup không cache
chéo tenant. Giao diện thử dùng component thật ở 320/390/768/1440 px.
Chưa có API key thật để xác nhận quota, entitlement và chất lượng dữ liệu trên
tài khoản Brave/Tavily/Hunter của chủ hệ thống.
