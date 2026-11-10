# ADR-011: Import framework với staging, mapping duyệt bởi người, rollback

- **Trạng thái:** Accepted
- **Bối cảnh:** Phải import từ Salesforce, HubSpot, Lark Suite, Excel/CSV. Import sai làm mất niềm tin ngay từ đầu; dữ liệu cũ thường thiếu consent.
- **Quyết định:** Pipeline: extract vào staging, discover, AI mapping đề xuất, **người duyệt mapping**, dry-run và báo cáo, **người duyệt commit**, commit theo batch idempotent (bảng `external_ids`), verify, delta sync tuỳ chọn, rollback theo `import_job_id`. Record không có consent rõ ràng thì `consent_status=unknown` và bị chặn outreach/delivery. Chạy dưới dạng DBOS workflow. Connector dùng chung interface với các integration khác.
- **Hệ quả:** (+) an toàn, lặp lại được, phù hợp nguyên tắc human gate. (−) nhiều bước hơn một nút "Import" đơn giản; bù lại bằng wizard và mapping mẫu cho từng nguồn.
