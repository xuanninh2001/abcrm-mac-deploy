# Decision Inbox & Approve-to-Contact Card (Phase 0–1)

## 1. Màn hình
```
┌ Inbox ─────────────────────────────────────────────────────────────────────┐
│ Lanes: [Contact 42] [Setup 2]          Filter: IPP ▾  Tier ▾  State ▾  Me ▾ │
│ View:  (•) Cards   ( ) Table (grouped review)          SLA: 3 due < 2h      │
├────────────────────────────────────────────────────────────────────────────┤
│ ▸ ACA & FE data-lead buyers · 18 cards · Tier A 7 / B 11                    │
│ ▸ Medicare data-lead buyers · 24 cards                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Card view (chi tiết)
| Vùng | Nội dung |
|---|---|
| Header | Tên công ty, domain (link), buyer type, verticals/lead types, HQ state, size; Tier và điểm; playbook vX; badge `injection_flag` nếu có |
| Why fit | 3 bullet (summary) và tối đa 2 risks |
| Criteria | Danh sách tiêu chí: ✔ pass / ✖ fail / ? unknown; mỗi dòng mở ra quote **highlight** và link evidence (URL và thời điểm truy cập); tiêu chí `unknown` có nút "Mark as verified by me" (ghi chú, không đổi scorecard) |
| Contacts | Checkbox theo contact: tên, title, match (exact/close), email status (valid/catch-all), LinkedIn URL (nếu có); preselected theo S2 |
| First email | Subject và body; **span AI highlight**; nút Edit (inline); toggle "Approve email now" (mặc định bật) |
| Actions | **Approve & queue** (A) · **Approve, no email yet** (Shift+A) · **Reject** (R, bắt chọn reason) · **Snooze** (S) · Next/Prev (J/K) |
| Footer | Credits đã dùng cho card (Agent và Contact); ID decision; "Why am I seeing this" (IPP, run) |

### 1.2 Table view (grouped review, D8)
Cột: ☐ · Company · Tier/Score · Top reason · Contact (title, status) · First line (AI) · Flags.
- Chọn nhiều dòng rồi bấm **Approve selected** (gọi `POST /cards/bulk-approve` với `content_hashes`).
- Bỏ chọn dòng nghi ngờ; mở chi tiết bằng Enter.
- Card thay đổi sau khi tải (hash lệch) bị loại khỏi lần duyệt và được đánh dấu "updated, review again".

### 1.3 Reject reasons (chuẩn hoá, dùng cho calibration)
`wrong_vertical` · `wrong_lead_type` · `competitor` · `too_small` · `too_large` · `already_working_with` · `recently_contacted` · `bad_reputation` · `not_us` · `wrong_contact` · `bad_email_draft` · `other` (bắt buộc note).
`bad_email_draft` không cần reject cả card: rep có thể duyệt G-Q và bỏ email (Shift+A), lúc đó G-OUT bị `rejected` với reason `bad_email_draft`.

## 2. State machine

### 2.1 Decision
```
pending ──approve──▶ approved ──executor──▶ executed
   │    ──edit+approve──▶ edited ──executor──▶ executed
   │    ──reject──▶ rejected
   │    ──expires_at──▶ expired
   │    ──subject changed / suppressed──▶ superseded
executed ──executor error──▶ failed (retry policy; sau N lần tạo decision mới)
```
- **G-Q + G-OUT (cùng card)**: approve card là một transaction: G-Q → approved, G-OUT → approved/edited/rejected theo toggle. Không thể approve G-OUT mà không approve G-Q (CHECK ở service).
- **Supersede**: account bị flag hoặc suppressed, contact bị global suppression, hoặc playbook mới re-qualify ra tier thấp hơn ngưỡng thì card `superseded` và biến mất khỏi Inbox.
- **Expiry**: card G-Q hết hạn sau 14 ngày (cấu hình); G-T1 không hết hạn.

### 2.2 Account status (do card)
`prospect → carded (card created) → approved (G-Q approved) | prospect (rejected; giữ lý do, cooldown 90 ngày) `

## 3. SLA & routing
- **Assignee**: card theo IPP owner, hoặc round-robin giữa `sales_rep` có `working_hours` đang mở; G-T1 cho `head_of_bd` hoặc `admin`.
- **SLA** (tính theo giờ làm việc của assignee, `users.timezone`): lane `contact` 1 ngày làm việc; lane `setup` 2 ngày làm việc. Quá SLA thì notify, sau đó reassign hoặc escalate tới head_of_bd.
- **Notifications** (Phase 1): email digest buổi sáng theo giờ địa phương của rep ("42 cards ready, 7 Tier A"), in-app badge, web push (PWA).

## 4. Hiệu năng & đo lường
- Card mở < 1s (prefetch 5 card kế tiếp); bulk approve 100 card < 3s.
- Metrics: `time_to_decide` (median, p90) theo rep; approval rate theo tier (precision); reject reasons; edit rate cho email; số card hết hạn.
- Mục tiêu Phase 1: median < 30 giây/card ở card view, < 10 giây/card ở table view.

## 5. Quyền
| Hành động | Owner/Admin | Head of BD | Sales Rep | Viewer |
|---|---|---|---|---|
| Xem Inbox | ✓ | ✓ | ✓ (card của mình và chưa giao) | ✓ (read-only) |
| Approve/Reject G-Q | ✓ | ✓ | ✓ | |
| Approve G-T1 | ✓ | ✓ | | |
| Reassign | ✓ | ✓ | | |
