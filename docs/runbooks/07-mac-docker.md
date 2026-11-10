# Mac mini M4: Docker, PostgreSQL và Cloudflare

## Kiến trúc

Cloudflare Tunnel → `web:3001` → `api:3000` → PostgreSQL 17.
Worker DBOS dùng database `abcrm_dbos` riêng. Image Node, pgvector và cloudflared có bản arm64 và amd64; Compose tự chọn kiến trúc máy, không ép giả lập amd64 trên M4.

`compose.production.yaml` độc lập với file Compose phát triển cũ. Chỉ web được bind ra `127.0.0.1`; API và PostgreSQL không mở port ra LAN/Internet. Production không bật dev auth. Mỗi service có quyền database riêng; chỉ job migration giữ tài khoản quản trị.

## Cài trên Mac

1. Cài Docker Desktop bản Apple Silicon (hoặc Colima có Docker Compose), khởi động engine. Cài Node.js 22 để chạy script cấu hình/backup.
2. Lấy mã nguồn có các file Docker mới và chạy từ thư mục gốc. Kiểm tra `docker info` và `docker compose version`.
3. Với **database mới**, tạo secrets:

```bash
node scripts/init-docker-env.mjs aurora.dbmediagroups.com
```

Script không ghi đè file đã có. Thay domain bằng hostname thật, không thêm `https://` hoặc đường dẫn. Điền `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` trong `.env.docker.local`; không commit file này. Bốn mật khẩu DB phải là 64 ký tự hex; khóa mã hóa là 32 byte base64. Giữ nguyên và sao lưu khóa khi redeploy. Docker Compose không phải kho secrets mã hóa: bảo vệ file và tài khoản quản trị Docker.

4. WorkOS: thêm `https://aurora.dbmediagroups.com/auth/callback` vào Redirect URIs của đúng application. Giữ redirect Render hiện tại nếu vẫn dùng song song.
5. Build và chạy:

```bash
docker compose --env-file .env.docker.local -f compose.production.yaml up -d --build
docker compose --env-file .env.docker.local -f compose.production.yaml ps -a
docker compose --env-file .env.docker.local -f compose.production.yaml logs --tail=100 migrate api web worker
```

Migration phải kết thúc mã 0, API/web healthy, worker ghi `abcrm worker started`. Migration lỗi sẽ chặn khởi động API/worker. Job bootstrap có thể chạy lại; không xóa dữ liệu. File môi trường luôn phải khớp mật khẩu volume hiện tại; đổi `POSTGRES_PASSWORD` không tự đổi mật khẩu DB đã khởi tạo.

## Domain và Tunnel

Hostname triển khai: urora.dbmediagroups.com. DNS hiện đã trả về địa chỉ proxy Cloudflare; cần kiểm tra bản ghi/route hiện có trong dashboard trước khi chuyển sang Tunnel mới. Không ghi đè route đang phục vụ dịch vụ khác.

1. Domain cần nằm trong Cloudflare DNS của tài khoản bạn quản lý.
2. Trong Cloudflare Zero Trust, tạo remotely managed Cloudflare Tunnel cho Mac mini. Lấy token, điền `CLOUDFLARE_TUNNEL_TOKEN` vào `.env.docker.local`.
3. Tạo published application route/public hostname: `aurora.dbmediagroups.com`; service **HTTP** `web:3001`. `localhost:3001` là sai vì cloudflared chạy trong container riêng.
4. Bật connector:

```bash
docker compose --env-file .env.docker.local -f compose.production.yaml --profile tunnel up -d
docker compose --env-file .env.docker.local -f compose.production.yaml logs --tail=50 tunnel
```

Không cần mở port router hoặc IP tĩnh. Truy cập domain HTTPS để đăng nhập; cookie production có cờ Secure nên không dùng HTTP localhost để kiểm thử login. Không cấu hình cache toàn bộ HTML/API trong Cloudflare.

## Tenant mới

Tạo Organization trong WorkOS, rồi:

```bash
docker compose --env-file .env.docker.local -f compose.production.yaml run --rm --no-deps migrate pnpm tenant:create --name "ABCRM" --slug abcrm --country VN --workos-org org_THAY_THE --owner-email xuanninhvps01@gmail.com
```

Chỉ chạy khi chưa có tenant tương ứng. Owner cần thành viên Organization và email được xác minh trên WorkOS. Không tự đánh dấu email đã xác minh. Đăng nhập rồi kiểm tra Inbox, Setup và Import.

## Chuyển dữ liệu Neon hiện có

Không coi lần khởi động database trống là đã chuyển dữ liệu. Chưa có dữ liệu Neon nào bị thay đổi/xóa bởi cấu hình này.

1. Dừng worker cũ và chặn ghi API cũ trong thời gian chuyển. Dump cả `abcrm` và `abcrm_dbos` bằng PostgreSQL 17 `pg_dump -Fc --no-owner` qua kết nối trực tiếp Neon có TLS. Không dùng pooled endpoint cho việc quản trị.
2. **Giữ nguyên** `ABCRM_MASTER_KEY`, `ABCRM_PLATFORM_HMAC_KEY`, `ABCRM_PLATFORM_CACHE_KEY`; giữ session secret nếu muốn. Tạo mới các khóa này sẽ làm dữ liệu mã hóa/index cũ không dùng được. File `.env.production.local` trên Windows hiện được mã hóa DPAPI, không thể giải mã trực tiếp trên Mac. Xuất các giá trị trên máy Windows rồi chuyển bằng kênh an toàn; không đưa vào Git hoặc chat.
3. Chuẩn bị volume PostgreSQL mới, khởi động riêng `postgres`. Khôi phục `abcrm` vào database trống. Vì dump không giữ ACL, tạo hai group NOLOGIN `abcrm_app`, `abcrm_global` trước khi restore (các RLS policy tham chiếu role); sau restore phải áp dụng lại các GRANT/REVOKE từ migrations cho schema hiện có. **Không đưa bản restore thiếu ACL vào sử dụng.** Cần diễn tập restore và kiểm tra quyền trước cutover.
4. Khôi phục DBOS vào database riêng, với ownership của bảng/schema thuộc `abcrm_dbos_user`. Không để worker mới và worker cũ cùng xử lý dữ liệu trong quá trình chuyển.
5. Chạy migration còn thiếu, kiểm tra RLS và thử giải mã một bản ghi thật. Kiểm tra owner đăng nhập, số lượng bản ghi và workflow trước chuyển domain. Giữ Neon để rollback cho đến khi xác nhận ổn định.

## Backup và khởi động lại

Tạm dừng ghi để hai dump cùng phản ánh một trạng thái nghiệp vụ:

```bash
docker compose --env-file .env.docker.local -f compose.production.yaml stop web api worker
node scripts/backup-docker.mjs
docker compose --env-file .env.docker.local -f compose.production.yaml up -d
```

Backup nằm trong `backups/`, không gồm secrets. Sao lưu riêng secrets có mã hóa và giữ bản backup ngoài Mac. Dump dùng `--no-owner`; áp dụng quy trình ACL/ownership và diễn tập restore như phần chuyển Neon trước khi dựa vào backup này. Không chạy `docker compose down -v` trừ khi chủ động muốn xóa toàn bộ database.

Bật Docker Desktop khởi động khi đăng nhập, không để Mac sleep khi phục vụ. `restart: unless-stopped` chỉ hoạt động khi Docker engine đang chạy. Kiểm tra lại sau reboot; FileVault hoặc màn hình đăng nhập có thể cần thao tác người dùng trước khi Docker Desktop hoạt động. Mất điện/mạng vẫn gây gián đoạn.

## Cập nhật

```bash
docker compose --env-file .env.docker.local -f compose.production.yaml stop web api worker
docker compose --env-file .env.docker.local -f compose.production.yaml build
docker compose --env-file .env.docker.local -f compose.production.yaml run --rm migrate
docker compose --env-file .env.docker.local -f compose.production.yaml up -d
```

Nếu build/migration lỗi, dừng tại bước đó để xử lý; không chạy tiếp. Tạo backup trước cập nhật. Các API Brave/Anthropic/Postmark/Stripe vẫn cần cấu hình riêng; Docker không thay thế các dịch vụ đó.
