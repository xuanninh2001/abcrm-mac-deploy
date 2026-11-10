# 03 · Sự cố

## Dừng ngay mọi agent của một tenant
- UI: **Agents → Kill switch → Stop all agents** (owner/admin), hoặc `POST /v1/tenant/kill-switch {"enabled": true}`.
- Không truy cập được UI: `UPDATE abcrm.tenants SET kill_switch = true WHERE id = '<tenant>';` (migrator).
- Hiệu lực: step agent kế tiếp bị huỷ; CRM và Inbox vẫn dùng được. Bật lại bằng `{"enabled": false}`.
- Khoá hẳn tenant (mọi đăng nhập bị từ chối): `UPDATE abcrm.tenants SET status = 'suspended' …`.

## Agent bị pause
Trang **Agents** hiện lý do:
| Lý do | Ý nghĩa | Xử lý |
|---|---|---|
| `budget` | Hết ngân sách ngày/tháng của agent | Tăng ngân sách hoặc chờ kỳ sau, rồi Resume |
| `anomaly` | Credit trong ngày > 5× trung bình 7 ngày | Kiểm tra run gần nhất (sourcing quá rộng? vòng lặp?) trước khi Resume |
| `quality_breaker` | < 20% card được duyệt trên ≥ 50 card gần nhất | Xem lý do reject, chỉnh playbook/IPP; Resume sau khi sửa |
| `entitlement` | Plan không có agent này | Đổi plan |
| `manual` | Có người pause | Hỏi người đó |

## Provider ngoài lỗi
| Provider | Biểu hiện | Hệ thống tự xử lý | Việc cần làm |
|---|---|---|---|
| Claude API | Lỗi/timeout ở log worker | Tiêu chí AI thành `unknown`, card không có draft (rep tự viết) | Theo dõi status page; không cần chạy lại thủ công |
| Search (Brave) | Run sourcing không có candidate mới hoặc lỗi ở log worker | Step lỗi được DBOS thử lại; các domain đã xử lý không chạy lại | Khi provider ổn: restart worker hoặc tạo run mới |
| Contact provider | Lookup `failed` hoặc 0 kết quả | Credit giữ trước được hoàn | Thử lại lookup sau |
| Postmark | Email thông báo `failed` | Bản in-app vẫn còn | Không cần làm gì |
| Stripe | Báo usage `failed` | Tự thử lại giờ sau | Kiểm tra nếu lỗi > 24 giờ |

## Workflow treo
- DBOS tự resume workflow khi worker khởi động lại. Restart worker là bước đầu tiên.
- Kiểm tra trong DBOS system database: bảng `dbos.workflow_status`, các dòng `status = 'PENDING'` lâu hoặc `ERROR`.
- Credit bị giữ quá 1 giờ do worker chết được `release_stale_reservations()` trả lại tự động (vòng bảo trì mỗi phút).

## Lệch số credit
`pnpm report:exit-criteria --tenant <id>` dòng "Usage balances not matching usage events" khác 0:
1. So sánh `SELECT meter, sum(credits) FROM abcrm.usage_events WHERE tenant_id = … AND occurred_at >= <period> GROUP BY meter` với `usage_balances.used`.
2. Không sửa tay số dư khi chưa tìm ra nguyên nhân; ghi lại idempotency key bất thường và mở issue.

## Card quá SLA hàng loạt
- Escalation tự động: quá SLA thì báo assignee; quá thêm 4 giờ thì chuyển cho rep đang trong giờ làm hoặc head of BD.
- Rep nghỉ dài ngày: **Team → Disable** chuyển card đang chờ của họ cho người khác (bật lại sau).

## API trả 429
- Giới hạn mặc định: 600 request/phút cho mỗi user hoặc API key; 30 lần đăng nhập thất bại/phút cho mỗi địa chỉ IP (bị chặn ~1 phút).
- Bộ đếm nằm trong bộ nhớ của từng instance API; restart API sẽ xoá.
