# Event Catalog (Phase 0–1)

## 1. Envelope
Mọi event ghi vào `outbox` trong **cùng transaction** với thay đổi dữ liệu, sau đó dispatcher (DBOS scheduled, 1s) chuyển tới consumer. Payload **chỉ chứa ID và trạng thái**, không có PII.

```json
{
  "id": "evt_01JB…",                 // uuidv7
  "topic": "sourcing.candidate.found",
  "version": 1,
  "tenant_id": "…",
  "occurred_at": "2026-10-25T03:12:44Z",
  "actor": { "type": "agent", "id": "run_…", "on_behalf_of": "persona:sourcing" },
  "subject": { "type": "candidate", "id": "…" },
  "causation_id": "evt_…",           // event gây ra event này
  "correlation_id": "srun_…",        // ví dụ sourcing_run_id
  "data": { }
}
```

**Quy tắc**
- Topic theo dạng `<module>.<entity>.<past_tense_verb>`; thay đổi breaking thì tăng `version` và chạy song song hai version trong một release.
- Consumer phải **idempotent** theo `event.id` (bảng `consumer_offsets(consumer, event_id)` hoặc DBOS workflow ID = `consumer:event_id`).
- Chống vòng lặp: Trigger Router từ chối khởi tạo agent run nếu chuỗi `causation_id` dài hơn 5, hoặc nếu cùng agent và cùng subject đã chạy trong 10 phút.

## 2. Catalog

### 2.1 IAM & platform
| Topic | Data | Producer | Consumers |
|---|---|---|---|
| `iam.tenant.created` | `{plan}` | signup | billing (khởi tạo `usage_balances`), seed personas, seed vertical packs |
| `iam.user.invited` / `iam.user.activated` | `{user_id, role}` | iam | notifications |
| `iam.user.disabled` / `iam.user.enabled` | `{user_id}` | iam | (audit) |
| `iam.tenant.kill_switch_changed` | `{enabled}` | admin | agents runtime (cancel/pause runs) |

### 2.2 Setup (Supply, IPP, Playbook)
| Topic | Data | Producer | Consumers |
|---|---|---|---|
| `supply.profile.submitted` | `{supply_profile_id, version}` | UI | decisions (tạo G-T1) |
| `supply.profile.activated` | `{supply_profile_id, version}` | decisions | agents (invalidate prompt cache key) |
| `ipp.submitted` / `ipp.activated` | `{ipp_id, version}` | UI / decisions | decisions / sourcing |
| `playbook.submitted` | `{playbook_id, version}` | UI | decisions (G-T1), qualification (chạy preview) |
| `playbook.preview.requested` | `{preview_id, playbook_id}` | API | qualification (chạy preview trong worker) |
| `playbook.preview.completed` | `{playbook_id, sample_size, tier_distribution}` | qualification | UI, decisions (gắn vào G-T1) |
| `playbook.activated` | `{playbook_id, version}` | decisions | qualification |

### 2.3 Sourcing
| Topic | Data | Producer | Consumers |
|---|---|---|---|
| `sourcing.run.requested` | `{sourcing_run_id, estimate:{agent, contact}}` | UI | decisions (G-T1 nếu vượt ngưỡng tenant, mặc định > 500 candidate hoặc > 5.000 credit) |
| `sourcing.run.started` | `{sourcing_run_id}` | sourcing | UI |
| `sourcing.candidate.found` | `{candidate_id, account_id, discovered_via_kind}` | S1 | sourcing (dedupe) |
| `sourcing.candidate.deduped` | `{candidate_id, reason}` | sourcing | analytics |
| `sourcing.candidate.ready` | `{candidate_id}` | sourcing | qualification |
| `sourcing.run.budget_exhausted` | `{sourcing_run_id, meter}` | sourcing | UI, notifications |
| `sourcing.run.completed` | `{sourcing_run_id, stats}` | sourcing | UI, notifications, analytics |

### 2.4 Qualification & Contact data
| Topic | Data | Producer | Consumers |
|---|---|---|---|
| `qualification.scorecard.created` | `{scorecard_id, candidate_id, account_id, tier, stopped_at?, card_eligible}` | Q1 | sourcing (stats), contactdata (nếu tier ≥ card_min_tier và chưa có contact) |
| `contactdata.lookup.requested` | `{contact_lookup_id, account_id, titles, limit}` | API | contactdata (lookup thủ công) |
| `contactdata.lookup.completed` | `{contact_lookup_id, account_id, found, verified}` | S2 | qualification (tạo card) |
| `contactdata.suppression.applied` | `{scope: global, affected_contacts}` | contactdata | crm (đổi trạng thái contact), decisions (supersede card đang chờ) |
| `qualification.card.proposed` | `{card_id, decision_ids:[G-Q, G-OUT…], account_id}` | Q1 và W1 | notifications, inbox |

### 2.5 Decisions
| Topic | Data | Producer | Consumers |
|---|---|---|---|
| `decisions.decision.created` | `{decision_id, gate_id, lane, card_id?}` | decisions | notifications |
| `decisions.decision.approved` | `{decision_id, gate_id, card_id?, edited:boolean}` | decisions | agent runtime (`DBOS.send`), crm (account.status), audit |
| `decisions.decision.rejected` | `{decision_id, gate_id, reason_code}` | decisions | agent runtime, analytics (calibration) |
| `decisions.decision.expired` | `{decision_id}` | scheduler | agent runtime |
| `decisions.decision.superseded` | `{decision_id, reason, card_id}` | DB trigger (account flag, contact suppressed) | inbox |
| `crm.account.approved_for_contact` | `{account_id, contact_ids, by}` | card executor | outreach (Phase 2) |

### 2.6 Import
| Topic | Data | Producer | Consumers |
|---|---|---|---|
| `import.job.staged` | `{job_id, rows}` | import | I1 (mapping) |
| `import.mapping.proposed` | `{job_id, mapping_id}` | I1 | UI |
| `import.job.dry_run_completed` | `{job_id, stats}` | import | UI |
| `import.job.committed` / `import.job.rolled_back` | `{job_id, stats}` | import | crm, sourcing (nếu purpose = sourcing_candidates) |

### 2.7 Agents & metering
| Topic | Data | Producer | Consumers |
|---|---|---|---|
| `agents.run.completed` / `agents.run.failed` | `{run_id, agent_definition_id, credits}` | runtime | analytics, guardrails |
| `agents.agent.paused` | `{agent_definition_id, reason}` | guardrails | notifications |
| `agents.agent.anomaly_detected` / `agents.agent.resumed` | `{agent_definition_id, …}` | guardrails / API | notifications |
| `billing.settings.changed` | `{meter}` | API | billing |
| `notifications.notification.created` | `{notification_id, kind}` | notify | worker (gửi email qua Mailer) |
| `decisions.card.reassigned` / `decisions.card.escalated` | `{card_id, assignee_user_id}` | inbox / sweep SLA | analytics |
| `qualification.criterion.verified_by_rep` | `{card_id, criterion_key, user_id}` | inbox | calibration (K1) |
| `billing.balance.threshold_crossed` | `{meter, pct: 50|80|100}` | metering | notifications |
| `billing.balance.exhausted` | `{meter}` | metering | runtime (pause tính phí), UI |

## 3. Sequence chính (Phase 1)
```
sourcing.run.requested → [G-T1?] → sourcing.run.started
  → sourcing.candidate.found → (dedupe) → sourcing.candidate.ready
  → qualification.scorecard.created (tier)
  → [tier ≥ card_min_tier] contactdata.lookup.completed
  → qualification.card.proposed → decisions.decision.created (G-Q, G-OUT)
  → decisions.decision.approved → account.status = approved, email_drafts.status = approved
```
