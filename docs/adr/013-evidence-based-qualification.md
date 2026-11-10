# ADR-013: Qualification engine dựa trên bằng chứng: rule + AI criteria, scoring bằng code

- **Trạng thái:** Proposed
- **Bối cảnh:** D15 yêu cầu bộ tiêu chí do khách tự tuỳ chỉnh. LLM có thể bịa bằng chứng hoặc bị prompt injection từ website của chính công ty đang được chấm. Rep chỉ tin card nếu thấy được nguồn. Chi phí research theo từng candidate là chi phí biến đổi lớn nhất.
- **Quyết định:**
  - Criterion có `kind` (knockout/must_have/scored) và `evaluation` (`rule` dùng JSONLogic trên dữ liệu có cấu trúc, `ai_judged` dùng LLM với evidence).
  - Thứ tự đánh giá: rule trước ai_judged, knockout trước; **dừng sớm** khi knockout fail.
  - LLM chỉ trả **kết quả từng tiêu chí** (pass/fail/unknown, confidence, rationale, quotes). **Tổng điểm và tier tính bằng code** từ weights; LLM không tự cho điểm.
  - **Quote verification**: mọi quote phải là substring (sau chuẩn hoá) của evidence đã lưu; quote không khớp bị loại; không còn bằng chứng thì `unknown`.
  - `unknown` là kết quả hợp lệ, xử lý theo `unknown_policy` của tiêu chí.
  - Playbook có version; scorecard bất biến theo version; preview trên mẫu trước khi publish (G-T1); calibration đề xuất thay đổi và cần duyệt.
- **Phương án đã cân nhắc:** để LLM chấm tổng điểm một lần (rẻ hơn nhưng khó kiểm chứng, dễ bị injection); chỉ dùng rule (không đủ cho tiêu chí như "chấp nhận publisher offshore").
- **Hệ quả:** (+) giải thích được, chống hallucination và injection, tối ưu chi phí. (−) cần UI builder tốt và preview; một số tiêu chí thường ra `unknown`, nên rep cần thấy rõ để quyết định.
