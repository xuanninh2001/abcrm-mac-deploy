# ADR-005: LLM Gateway với model tiering

- **Trạng thái:** Accepted (cập nhật v0.2)
- **Bối cảnh:** Chi phí và chất lượng model thay đổi nhanh; giá bán theo credit nên cần kiểm soát chi phí từng hành động; cell EU có thể cần xử lý LLM trong EU.
- **Quyết định:** LLM Gateway là **module** trong worker (không phải service riêng). Agent khai báo tier (`small`/`medium`/`large`); gateway map tier sang model, provider và endpoint **theo cell** (mặc định Claude Haiku/Sonnet/Opus; MVP chỉ có cell US). Gateway lo prompt caching, Batch API cho tác vụ không gấp, retry/fallback, metering token/chi phí theo tenant/agent/run, redact PII trong trace.
- **Hệ quả:** (+) đổi model bằng cấu hình; đo được gross margin theo hành động. (−) abstraction chỉ bao phần chung; tính năng đặc thù provider dùng pass-through có kiểm soát.
