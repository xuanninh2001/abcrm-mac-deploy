# ABCRM — Pricing & Usage Metering

> Nguyên tắc:
> - Giá gồm **seat** và **volume hành động agent**; **không giới hạn số agent**; tính **overage** khi vượt mức của plan (D4).
> - Đề xuất bị từ chối vẫn tính credit (D12).
> - ABCRM cung cấp contact data và tính phí trong credit (D21).
> - Seat rẻ, doanh thu chủ yếu đến từ credit (D22).
> - **Không giới hạn số agent; giới hạn volume (credit) và công suất (concurrency, monitor, mailbox); upsell bằng năng lực; hoá đơn không bao giờ bất ngờ** (D28).
>
> Mọi con số dưới đây là **ví dụ để brainstorm**, cần hiệu chỉnh sau spike chi phí (LLM, search, contact data) và phỏng vấn design partner.

## 1. Hai meter

| Meter | Đo gì | Vì sao tách riêng |
|---|---|---|
| **Agent Credits** | Hành động AI: sourcing, scorecard, soạn email/reply, brief, phân tích | Chi phí chủ yếu là LLM và search, thấp và ổn định trên mỗi đơn vị |
| **Contact Credits** | Mỗi **contact có email verified** do ABCRM cung cấp | Chi phí provider dữ liệu cao hơn nhiều và biến động; khách quen so sánh "giá mỗi contact" với Apollo/ZoomInfo. Tách ra giúp minh bạch và bảo vệ margin |

Cả hai đều là "volume hành động của agent", dùng chung quy tắc metering, cảnh báo và spend cap.

### 1.1 Agent Credits: trọng số
| Hành động | Ví dụ | Agent Credits |
|---|---|---|
| Candidate sourced | Một công ty mới có evidence (search, fetch, extract, tech signals) | 2 |
| Candidate bị dedupe | Trùng CRM, blocklist, đã liên hệ | 0 |
| Scorecard (chỉ rule, hoặc dừng ở knockout) | | 1 |
| Scorecard có ai_judged criteria | Nghiên cứu và phán đoán có trích dẫn | 4 |
| Approve-to-Contact card | Gồm email đầu tiên cá nhân hoá | 2 |
| Follow-up từ template đã duyệt (merge field) | D18 | **0** |
| Phân loại reply | R1 | 1 |
| Soạn reply / email terms | R1, B1 | 2 |
| Meeting brief / notes | M1 | 3 |
| Buyer due diligence | D1 | 3 |
| RedTrack sync, báo cáo performance | P1 (mỗi buyer/tháng) | 1 |
| Calibration report | K1 | 5 |
| Copilot | Mỗi câu hỏi | 1 |
| **Signal classified** (D27) | Mỗi item mới sau dedupe được phân loại và trích xuất | 0,2 (tính theo lô 5 item = 1 credit) |
| Signal promoted | Tín hiệu khớp thành candidate (sau đó tính như candidate và scorecard thông thường) | 1 |
| Manual signal capture | Rep tự gửi vào | 0 (phân loại vẫn tính như trên) |
| Import mapping (AI) | | **0** |

### 1.2 Contact Credits
| Kết quả | Contact Credits |
|---|---|
| Contact có **email verified (valid)**, kèm LinkedIn URL nếu provider có (không tính thêm) | 1 |
| Contact email **catch-all** (rủi ro, có đánh dấu) | 0,5 (làm tròn theo lô) |
| Không tìm thấy / invalid | **0** |
| Contact do tenant tự import | **0** (chỉ tính phí verify nếu tenant chọn verify: 0,2) |
| Contact được làm mới (re-verify sau 90 ngày) | 0,2 |

### 1.3 Ví dụ: chi phí một business lead đi đến thẻ duyệt
`sourced 2 + scorecard 4 + card 2 = 8 Agent Credits` và `2 contact verified = 2 Contact Credits`.
Candidate bị loại ở knockout: khoảng 3 Agent Credits và 0 Contact Credit, vì **tìm contact chạy sau knockout** để không tốn tiền dữ liệu cho công ty không phù hợp.

### 1.4 Không tính phí
- Opt-out, unsubscribe, DSAR, suppression (không bao giờ tính phí, không bao giờ bị pause).
- Thao tác của con người; rule automation; follow-up deterministic.
- Run lỗi do hệ thống; retry nội bộ; read tools.

### 1.5 Đề xuất bị từ chối: có tính (D12)
Credit ghi khi decision được tạo. Usage dashboard hiển thị acceptance rate theo agent/IPP/playbook và credit "lãng phí", kèm gợi ý chỉnh playbook.

## 2. Plans (ví dụ minh hoạ, định giá cho agency offshore)

### 2.0 Vì sao không giới hạn số agent (D28)
- **Chi phí nằm ở hành động, không nằm ở số agent.** Một agent bận có thể tốn gấp 100 lần một agent nhàn.
- **Sản phẩm hoạt động tốt nhất khi agent chuyên biệt** (một agent cho mỗi IPP, playbook hoặc monitor). Giới hạn số agent đẩy khách gộp chúng lại, khiến chất lượng qualify giảm.
- **Giới hạn số agent dễ lách** bằng một "mega-agent".
- Điểm yếu của mô hình volume là **khó hình dung và sợ phát sinh**. Khắc phục bằng: quy đổi ra kết quả (§2.2), spend cap mặc định (§3), credit packs, ước tính trước mỗi run, và thang upsell theo năng lực (§2.3).

| | **Starter** | **Growth** | **Scale** | **Enterprise** |
|---|---|---|---|---|
| Giá seat / tháng (annual) | **$29** | **$59** | **$119** | Custom |
| Seat tối thiểu | 1 | 2 | 5 | 10 |
| Agent Credits included / tháng (theo tenant) | 3.000 | 15.000 | 50.000 | Custom |
| Contact Credits included / tháng | 200 | 1.000 | 4.000 | Custom |
| Overage Agent Credits / 1.000 | $12 | $10 | $8 | Commit |
| Overage Contact Credit / contact | $0,30 | $0,25 | $0,20 | Commit |
| **≈ Kết quả mỗi tháng** (xem §2.2) | **~100 buyer card** | **~500 buyer card** | **~2.000 buyer card** | Custom |
| Số agent / IPP / Playbook | Không giới hạn | Không giới hạn | Không giới hạn | Không giới hạn |
| Agent chạy đồng thời | 2 | 6 | 20 | Custom |
| Mailbox kết nối | 5 | 25 | 100 | Custom |
| RedTrack integration | — | ✓ | ✓ | ✓ |
| Signal Monitors đang chạy (tạo không giới hạn) | 2 | 10 | 40 | Custom |
| Tần suất poll tối thiểu | 6 giờ | 3 giờ | 1 giờ | Custom |
| Model tier tối đa | medium | medium | large | large |
| Credit packs trả trước (rẻ hơn overage khoảng 20%) | ✓ | ✓ | ✓ | ✓ |
| **Overage mặc định** | **Tắt (hard stop)** | Bật, spend cap mặc định = 50% giá plan | Bật, spend cap mặc định = 50% giá plan | Theo hợp đồng |
| Ngân sách credit theo agent (tuỳ chọn) | ✓ | ✓ | ✓ | ✓ |
| SSO, audit export | — | — | SSO | SSO + audit export |

### 2.1 Ghi chú
- **Included credits tính theo tenant** (không theo seat), nên doanh thu dịch chuyển sang credit đúng như D22.
- **Viewer seat** miễn phí. Người duyệt G-Q dùng seat thường.
- **Thanh toán**: Stripe của pháp nhân Singapore, niêm yết USD; Stripe Tax (sales tax SaaS tại các bang US khi có nexus, GST cho khách Singapore). Agency offshore thường thanh toán bằng thẻ quốc tế; cân nhắc hỗ trợ chuyển khoản cho annual plan.
- **Free trial**: 14 ngày, 1.000 Agent Credits và 50 Contact Credits; yêu cầu thẻ để hạn chế lạm dụng contact data.

### 2.2 Quy đổi credit ra kết quả (trang pricing nói bằng kết quả, không bằng credit)
Giả định (hiệu chỉnh sau spike và dữ liệu thật):
- Khoảng 30% candidate thành card (Tier A/B); candidate bị loại tốn khoảng 3 Agent Credits.
- Một card tốn khoảng 8 Agent Credits và 2 Contact Credits.

```
Agent Credits / card ≈ 8 + (0,7/0,3) × 3 ≈ 15
Contact Credits / card ≈ 2
```

| Plan | Agent Credits | Contact Credits | ≈ Buyer cards/tháng | Agent Credits còn cho reply, signals, brief… |
|---|---|---|---|---|
| Starter | 3.000 | 200 | ~100 | ~1.500 |
| Growth | 15.000 | 1.000 | ~500 | ~7.500 |
| Scale | 50.000 | 4.000 | ~2.000 | ~20.000 |

**"Buyer card"** = một buyer đã qualify (có scorecard và bằng chứng), có 1–2 contact verified và email đầu tiên sẵn sàng để rep duyệt. Trang pricing và onboarding dùng đơn vị này. Credit là đơn vị kỹ thuật hiển thị trong usage dashboard.

### 2.3 Thang upsell theo năng lực (không theo số agent)
| Năng lực / Template | Starter | Growth | Scale | Enterprise |
|---|---|---|---|---|
| S1 Sourcing, S2 Contact Finder, Q1 Qualification, W1 Writer | ✓ | ✓ | ✓ | ✓ |
| Outreach, R1 Reply Handler, H1 Deliverability | ✓ | ✓ | ✓ | ✓ |
| Pipeline, Partnership terms (B1), M1 Meeting brief | ✓ | ✓ | ✓ | ✓ |
| **L1 Intent Listener** (Signal Monitors) | 2 monitor | ✓ | ✓ | ✓ |
| **D1 Buyer Due Diligence** | — | ✓ | ✓ | ✓ |
| **P1 RedTrack Performance** | — | ✓ | ✓ | ✓ |
| **K1 Playbook Calibrator** | — | — | ✓ | ✓ |
| C1 Copilot | Cơ bản | ✓ | ✓ | ✓ |
| Model tier large | — | — | ✓ | ✓ |
| SSO, audit export | — | — | SSO | SSO + audit export |

### 2.4 Unit economics (cần đo trong spike)
```
Agent Credits:   chi phí biến đổi (LLM + search + fetch) / credit ≤ 30% giá overage thấp nhất
                 ($8/1k → ≤ $0,0024/credit)
Contact Credits: chi phí provider (waterfall, trừ cache hit) + verify / contact verified
                 ≤ 50% giá overage thấp nhất ($0,20 → ≤ $0,10/contact)
```
- Contact data là rủi ro margin lớn nhất (R8). Các đòn bẩy giảm chi phí:
  - Waterfall rẻ trước, đắt sau.
  - **Licensed cache dùng chung**, nếu license của provider cho phép.
  - Chỉ tìm contact sau khi qua knockout.
  - Giới hạn số contact/công ty (mặc định 2).
- Nếu chi phí thực vượt mục tiêu, **tăng trọng số hoặc giá của riêng meter đó**, không tăng giá seat.

## 3. Hành vi khi vượt mức
| Trạng thái | Điều kiện | Hành vi |
|---|---|---|
| Normal | < 50% included (từng meter) | — |
| Heads-up | ≥ 50% | Thông báo in-app kèm dự báo ngày hết |
| Warning | ≥ 80% | Thông báo owner/admin (in-app và email); gợi ý credit pack |
| Overage | ≥ 100%, overage bật (mặc định bật từ Growth, kèm spend cap mặc định = 50% giá plan) | Tiếp tục chạy, tính overage; thông báo khi overage đạt 50% và 100% spend cap |
| Spend cap reached | Overage chạm cap do tenant đặt (riêng cho từng meter) | Pause hành động tính phí của meter đó; dữ liệu và pipeline vẫn dùng bình thường; **compliance actions vẫn chạy** |
| Hard stop (mặc định của Starter) | ≥ 100% | Như trên; nút mua credit pack; tenant có thể tự bật overage |

Sourcing run có **budget riêng** (Agent và Contact) được reserve trước. Chạm budget thì run dừng gọn và báo tóm tắt.

### 3.1 Guardrails theo agent (chống "agent đốt credit")
| Cơ chế | Mô tả | Mặc định |
|---|---|---|
| **Ngân sách theo agent** | `credit_budget_daily` / `credit_budget_monthly` cho từng agent; chạm thì agent pause và thông báo | Tắt; gợi ý bật khi tạo agent có trigger tần suất cao |
| **Anomaly alert** | Agent tiêu > 3× trung bình 7 ngày của chính nó trong 24h thì cảnh báo; > 5× thì tự pause, chờ admin mở lại | Bật |
| **Circuit breaker chất lượng** | Acceptance rate của agent < 20% trên ≥ 50 đề xuất gần nhất, hoặc lỗi liên tục, thì pause và gợi ý chỉnh playbook | Bật |
| **Ước tính trước khi bật** | Khi tạo hoặc sửa agent: "dự kiến ~X credit/tháng" dựa trên volume 30 ngày | Luôn hiển thị |
| **Concurrency theo plan** | Giới hạn số agent chạy đồng thời (công suất, không phải số agent tạo ra) | Theo plan |

## 4. Kiến trúc metering
```mermaid
flowchart LR
    ACT[Tool Executor / Run] -->|same tx| UE[(usage_events<br/>meter = agent|contact)]
    ACT -->|pre-check| BAL[(usage_balances<br/>per meter, atomic)]
    UE --> AGG[Hourly aggregator]
    AGG --> STRIPE[Stripe Meters: agent_credits, contact_credits]
    STRIPE --> INV[Invoice: seats + overage]
    UE --> REC[Daily reconciliation]
    UE --> DASH[Usage dashboard]
    ACT --> COST[(internal cost ledger<br/>LLM, search, provider)]
    COST --> MARGIN[Margin dashboard nội bộ<br/>theo tenant, meter, provider]
```
1. **Reserve** trên `usage_balances(tenant, period, meter)` bằng `UPDATE … WHERE used + n <= included OR (overage_enabled AND … <= spend_cap) RETURNING`.
2. **Record** `usage_events` cùng transaction, `idempotency_key = run:step:action`.
3. **Release** phần reserve không dùng: Contact lookup reserve theo `limit`, commit theo số contact verified thực tế.
4. **Report** hằng giờ sang Stripe Meters (chỉ số lượng, không PII); **reconcile** hằng ngày.
5. **Internal cost ledger** ghi chi phí thực (token, search call, provider lookup) để theo dõi margin theo meter và theo provider.
6. **Seat sync** sang subscription quantity.

## 5. Minh bạch cho khách hàng
- Usage dashboard theo meter, agent, IPP, sourcing run.
- Funnel chi phí: credit trên mỗi candidate, mỗi card, mỗi contact verified, mỗi meeting, mỗi buyer won. Khi có RedTrack thì thêm **credit trên mỗi $ doanh thu**.
- Ước tính trước mỗi sourcing run: "200 candidate ≈ 1.600 Agent Credits và 120 Contact Credits."

## 6. Câu hỏi mở
1. Mức included và giá overage của Contact Credits phụ thuộc giá provider thật (spike).
2. Số điện thoại: không có trong MVP (D26); xem xét lại nếu có nhu cầu.
3. Có cho tenant BYO key provider (giảm Contact Credit về 0) ở plan Scale/Enterprise không?
4. Credit packs có hạn sử dụng (ví dụ 12 tháng) không?
5. **Gói "AI SDR seat" trọn gói (tương lai)**: nếu thị trường muốn mua theo "nhân viên số", có thể thêm gói giá cố định, trong đó đã gồm một lượng credit và một agent persona có hộp thư riêng, chạy trên cùng hệ thống metering. Không làm trong MVP.
