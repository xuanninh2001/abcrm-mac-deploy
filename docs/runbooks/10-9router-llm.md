# Kết nối Aurora với 9router

## Kết quả khảo sát

Nguồn: [README](https://github.com/decolua/9router/blob/master/README.md),
[chat completions](https://github.com/decolua/9router/blob/master/src/app/api/v1/chat/completions/route.js),
[models](https://github.com/decolua/9router/blob/master/src/app/api/v1/models/route.js),
[URL rewrites](https://github.com/decolua/9router/blob/master/next.config.mjs).

9router cung cấp `/v1/chat/completions` và `/v1/models`, dùng
`Authorization: Bearer <API key>`. URL `/v1` được rewrite về `/api/v1`.
Model có thể là ID có tiền tố nhà cung cấp hoặc tên combo. Danh sách phụ thuộc
provider được kết nối, key và cấu hình của từng instance; không hardcode model.

Aurora dùng adapter OpenAI-compatible riêng, không gửi Anthropic beta headers,
effort, cache_control hay server-side fallback. Request không stream, hướng dẫn
model trả JSON theo schema, và kiểm tra lại bằng Zod trước khi sử dụng. JSON mode
là tùy chọn vì không phải provider nào cũng hỗ trợ `response_format`.
JSON bọc trong một code fence được chấp nhận; nội dung sai schema, refusal và
output bị cắt bị từ chối. Lỗi không làm hệ thống tự đổi sang provider khác.
Fallback/rotation do combo và cấu hình 9router quản lý.

## Cấu hình trong web

1. Đăng nhập bằng **owner**, mở **AI / LLM** (`/llm`).
2. Chọn **9router / OpenAI-compatible tunnel**.
3. Nhập URL HTTPS tunnel (root hoặc kết thúc bằng `/v1`) và API key từ 9router.
4. Bấm **Load models**, chọn ID chính xác hoặc nhập tên combo. Không xóa tiền tố
   như `cc/` hoặc `kr/`. Một model/combo phục vụ cả ba tier trong Aurora.
5. Giữ JSON mode tắt trước; bật nếu provider hỗ trợ.
6. Bấm **Test connection**. Đây là một yêu cầu AI nhỏ, có thể tiêu quota; kết quả
   thành công xác nhận response JSON đúng schema, không chỉ kiểm tra HTTP.
7. Bấm **Save configuration**. Test/load models không tự lưu.

Key lưu mã hóa theo tenant trong PostgreSQL, không trả lại UI. Để trống key khi
lưu sẽ giữ key cũ. Đổi URL phải nhập lại key. Chuyển sang environment/disabled
có thể chọn xóa key đã lưu. Chỉ owner được đọc/lưu/test cấu hình.

Worker đọc cấu hình cho mỗi sourcing, qualification, preview hoặc bước tạo card
mới. Không cần restart khi đổi cấu hình; workflow đang chạy có thể hoàn thành
với cấu hình trước đó. Không có cấu hình DB thì vẫn dùng Claude từ môi trường.
Chọn disabled dùng cơ chế fallback không-AI hiện có.

URL phải là hostname HTTPS công khai, port 443; không hỗ trợ HTTP/LAN trực tiếp.
DNS được kiểm tra tại kết nối socket để chặn địa chỉ nội bộ và metadata; không
theo redirect mang key. Timeout 120 giây, response tối đa 2 MiB. Tunnel phải
truy cập được bằng Bearer key, không bị trang đăng nhập Cloudflare Access chặn.
Trong 9router, bật yêu cầu API key khi công khai endpoint (`REQUIRE_API_KEY=true`).

Chi phí là **ước tính nội bộ**, dùng giá input/output USD trên một triệu token
do owner nhập. 0 nghĩa là không ghi nhận giá ước tính, không có nghĩa provider
miễn phí. Combo có thể đổi model nên cần chọn giá phù hợp; đối soát hóa đơn tại
9router/provider. Token cache không được tách riêng trong adapter này.

## Cập nhật Mac sau khi source được push

Bản này thay đổi API, worker, web và thêm migration `0013_llm_settings.sql`.
Không chỉ rebuild web. Trong thư mục dự án có `.env.docker.local`:

```bash
git pull --ff-only origin main
docker compose --env-file .env.docker.local -f compose.production.yaml build api web
docker compose --env-file .env.docker.local -f compose.production.yaml run --rm --no-deps migrate
docker compose --env-file .env.docker.local -f compose.production.yaml up -d --no-deps --force-recreate api worker web
docker compose --env-file .env.docker.local -f compose.production.yaml ps
docker compose --env-file .env.docker.local -f compose.production.yaml logs --tail=60 api worker web
```

Chỉ chạy lệnh sau khi lệnh trước thành công. API, worker và migrate cùng dùng
image `abcrm-runtime:local` nên build api cập nhật cả runtime. PostgreSQL cần đang
chạy để chạy migrate với `--no-deps`. Không xóa volume, không sửa tunnel Aurora.
Nên cập nhật khi không có tác vụ đang chạy và có bản backup PostgreSQL gần nhất.

## Kiểm chứng và giới hạn

Kiểm thử adapter, quyền API, migration/PostgreSQL/RLS, key mã hóa, model list,
test không lưu, UI và luồng worker dùng cấu hình theo tenant. Provider được mock
trong kiểm thử tự động; chưa xác nhận endpoint 9router thực tế của chủ hệ thống.
Build/typecheck không chứng minh quota hoặc model trên instance riêng hoạt động.
