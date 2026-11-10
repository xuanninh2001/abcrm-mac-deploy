# Tool Catalog v1 (Phase 0–1)

Tool là **typed action** dùng chung cho agent, UI (server actions) và public API. Định nghĩa trong `packages/agents/tools/*` bằng `defineTool`.

## 1. Định nghĩa
```ts
type SideEffect = "none" | "internal" | "external";
type Gate = "G-T1" | "G-T2" | "G-Q" | "G-OUT" | "G-M1" | "G-M2" | "G-B1" | "G-B2";

interface ToolDef<I, O> {
  name: string;                       // "<module>.<verb>"
  description: string;                // dùng làm tool description cho LLM
  sideEffect: SideEffect;
  gate?: Gate;                        // có gate thì tool chỉ PROPOSE (tạo decision), không execute
  permission: Permission;             // kiểm tra trên danh tính on_behalf_of
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  precheck?: (ctx: ToolCtx, i: I) => Promise<PolicyResult>;   // invariants bổ sung
  execute: (ctx: ToolCtx, i: I) => Promise<O>;
  meter?: (i: I, o: O) => { meter: "agent" | "contact"; actionType: string; credits: number } | null;
  idempotencyKey?: (ctx: ToolCtx, i: I) => string;            // mặc định run:step
  exposeToLLM: boolean;               // false = chỉ gọi từ code (workflow)
}

interface ToolCtx {
  tenantId: string;
  actor: { type: "agent"; runId: string } | { type: "user"; userId: string } | { type: "system" };
  onBehalfOf: { type: "user" | "persona"; id: string };
  tx: TenantTx;                       // transaction đã set app.tenant_id
  runStep?: { runId: string; seq: number };
}
```

**Pipeline thực thi** (Tool Executor):
```
validate(input) → resolve permission(onBehalfOf) → entitlement(plan, agent budget, balance)
 → platform invariants → precheck → [gate? create decision : execute] → meter (same tx) → audit → outbox
```

## 2. Permissions
| Permission | Owner | Admin | Head of BD | Sales Rep | Viewer | Persona `sourcing` | Persona `qualification` |
|---|---|---|---|---|---|---|---|
| `setup.supply.write` | ✓ | ✓ | ✓ | | | | |
| `setup.ipp.write` / `setup.playbook.write` | ✓ | ✓ | ✓ | | | | |
| `setup.approve` (G-T1) | ✓ | ✓ | ✓ | | | | |
| `sourcing.run.start` | ✓ | ✓ | ✓ | ✓ (nếu dưới ngưỡng G-T1) | | | |
| `sourcing.write` (candidate, evidence, account upsert) | ✓ | ✓ | | | | ✓ | |
| `web.read` (search, fetch) | | | | | | ✓ | ✓ |
| `contactdata.lookup` | ✓ | ✓ | ✓ | ✓ | | | ✓ |
| `qualification.write` (scorecard) | | | | | | | ✓ |
| `decisions.propose` | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| `decisions.approve.G-Q` | ✓ | ✓ | ✓ | ✓ | | | |
| `crm.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `crm.write` | ✓ | ✓ | ✓ | ✓ | | ✓ (giới hạn) | |
| `import.run` | ✓ | ✓ | | | | | |
| `agents.manage` | ✓ | ✓ | ✓ | | | | |
| `billing.manage` | ✓ | ✓ | | | | | |
| `users.manage` | ✓ | ✓ | | | | | |

Persona **không bao giờ** có quyền `decisions.approve.*`. Agent không thể tự duyệt (invariant).

## 3. Tools

### 3.1 Web & sourcing
| Tool | sideEffect | Gate | Permission | LLM | Meter |
|---|---|---|---|---|---|
| `web.search` | none | — | `web.read` | ✓ | gộp vào `candidate_sourced` |
| `web.fetch` | none | — | `web.read` | ✓ | gộp |
| `signals.detect_tech` | none | — | `web.read` | ✗ (code) | 0 |
| `evidence.save` | internal | — | `sourcing.write` | ✓ | 0 |
| `account.upsert_from_domain` | internal | — | `sourcing.write` | ✓ | 0 |
| `candidate.create` | internal | — | `sourcing.write` | ✓ | agent: `candidate_sourced` = 2 (0 nếu bị dedupe) |

```ts
web.search.input  = z.object({ query: z.string().max(256), recencyDays: z.number().int().max(365).optional(), limit: z.number().int().max(20).default(10) })
web.search.output = z.object({ results: z.array(z.object({ url: z.string().url(), title: z.string(), snippet: z.string(), publishedAt: z.string().optional() })) })

web.fetch.input   = z.object({ url: z.string().url(), purpose: z.enum(["home","partners","careers","about","compliance","other"]) })
web.fetch.output  = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), pageRef: z.string(), text: z.string().max(40_000), fromCache: z.boolean(), injectionFlag: z.boolean() }),
  z.object({ status: z.enum(["denied_policy","denied_robots","rate_limited","not_found","error"]), reason: z.string() }),
])
// precheck: crawl_policy deny (linkedin.com…), robots, per-domain rate limit (global), public only.

evidence.save.input = z.object({ accountId: z.string().uuid(), kind: z.enum(["web_page","search_result","tech_signal"]),
                                 url: z.string().url().optional(), snippet: z.string().min(20).max(4000), pageRef: z.string().optional() })
// execute: normalize whitespace, content_hash, verify snippet ⊂ page text (if pageRef) — reject otherwise.

account.upsert_from_domain.input = z.object({ domain: z.string(), name: z.string(), facts: z.object({
   buyerType: z.enum(["direct_brand","aggregator","affiliate_network","ping_post_exchange","call_buyer","unknown"]).optional(),
   verticals: z.array(z.string()).optional(), leadTypes: z.array(z.string()).optional(), hqState: z.string().length(2).optional(),
   employeeRange: z.string().optional() }).partial() })
// execute: normalize eTLD+1, domain_bidx; never overwrite fields edited by a user (record_changes actor_type='user').

candidate.create.input = z.object({ sourcingRunId: z.string().uuid(), accountId: z.string().uuid(),
                                    discoveredVia: z.object({ kind: z.enum(["search","directory","import","manual"]), query: z.string().optional(), url: z.string().optional() }) })
// execute: dedupe (existing_account w/ status≠prospect, flags, suppression_entries domain, recently_contacted 90d) → status found|deduped
```

### 3.2 Contact data
| Tool | sideEffect | Gate | Permission | LLM | Meter |
|---|---|---|---|---|---|
| `contact.find` | none (vendor call) | — | `contactdata.lookup` | ✗ (workflow gọi) | contact: 1/verified, 0,5/catch-all, 0/không có |
| `email.verify` | none | — | `contactdata.lookup` | ✗ | contact: 0,2 (chỉ contact import) |

```ts
contact.find.input = z.object({ accountId: z.string().uuid(), titles: z.array(z.string()).min(1).max(10),
                                limit: z.number().int().min(1).max(5), candidateId: z.string().uuid().optional() })
contact.find.output = z.object({ contacts: z.array(z.object({ contactId: z.string().uuid(), title: z.string(),
                                 titleMatch: z.enum(["exact","close","weak"]), emailStatus: z.enum(["valid","catch_all"]),
                                 linkedinUrl: z.string().url().optional(), source: z.string() })), contactCredits: z.number() })
// flow: reserve(limit) → global suppression(domain) → licensed cache → waterfall → verify → global suppression(email)
//       → write contacts (source) → commit credits = Σ, release rest. See system design §5.7.
```

### 3.3 Qualification
| Tool | sideEffect | Gate | Permission | LLM | Meter |
|---|---|---|---|---|---|
| `playbook.get` | none | — | `crm.read` | ✓ | 0 |
| `criterion.record_result` | internal | — | `qualification.write` | ✓ | 0 |
| `scorecard.finalize` | internal | — | `qualification.write` | ✗ (code) | agent: 1 (rule-only/knockout) hoặc 4 (có ai_judged) |

```ts
criterion.record_result.input = z.object({
  scorecardDraftId: z.string().uuid(), criterionKey: z.string(),
  result: z.enum(["pass","fail","unknown"]), confidence: z.number().min(0).max(1),
  rationale: z.string().max(600),
  quotes: z.array(z.object({ evidenceId: z.string().uuid(), text: z.string().min(8).max(400) })).max(5) })
// execute: VERIFY each quote: normalize(text) ⊂ normalize(evidence.snippet). Drop unverified.
//          if criterion.evidence_required && result=='pass' && verifiedQuotes==0 → result='unknown' (+ flag).
// scorecard.finalize: compute points/tier in code (ipp-playbook-format.md §3). LLM cannot set score.
```

### 3.4 Decisions & drafts
| Tool | sideEffect | Gate | Permission | LLM | Meter |
|---|---|---|---|---|---|
| `card.propose_contact` | internal | **G-Q** (+ G-OUT trong cùng card) | `decisions.propose` | ✗ (Q1 workflow) | agent: 2 |
| `email_draft.compose` | internal | — (là phần của card) | `decisions.propose` | ✓ (W1) | gộp vào card |
| `setup.propose` | internal | **G-T1** | `decisions.propose` | ✗ | 0 |

```ts
card.propose_contact.input = z.object({
  accountId: z.string().uuid(), scorecardId: z.string().uuid(),
  contacts: z.array(z.object({ contactId: z.string().uuid(), preselected: z.boolean() })).min(1).max(5),
  draft: z.object({ contactId: z.string().uuid(), subject: z.string().max(120), body: z.string().max(2500),
                    aiSpans: z.array(z.object({ start: z.number().int(), end: z.number().int() })) }) })
// execute: create decisions G-Q (action: {tool:'account.approve_contact', args:{accountId, contactIds}})
//          and G-OUT (action: {tool:'email_draft.approve', args:{draftId}}), same card_id, lane 'contact'
//          (or 'hot-intent' in Phase 2), content_hash per decision, SLA from assignee working hours.
```

### 3.5 Tools chỉ chạy sau khi được duyệt (executor gọi, không expose cho LLM)
| Tool | Chạy khi | Hiệu ứng |
|---|---|---|
| `account.approve_contact` | G-Q `approved/edited` | `accounts.status='approved'`; lưu danh sách contact được duyệt |
| `email_draft.approve` | G-OUT `approved/edited` | `email_drafts.status='approved'` (Phase 2 mới gửi) |
| `setup.activate` | G-T1 `approved` | Kích hoạt version mới của Supply/IPP/Playbook, archive version cũ |
| `sourcing_run.start` | G-T1 `approved` (hoặc dưới ngưỡng) | Enqueue workflow |

**Invariant executor:** chỉ chạy khi `decision.status ∈ {approved, edited}`, `decision.tenant_id = ctx.tenantId`, hash khớp (`final_content_hash` nếu edited), chưa `executed` (cập nhật `status='executed'` trong cùng transaction; unique index đảm bảo exactly-once).

### 3.6 Import
| Tool | sideEffect | Gate | LLM | Meter |
|---|---|---|---|---|
| `import.propose_mapping` (I1) | internal | duyệt mapping trên UI | ✓ | 0 |
| `import.commit` | internal | người dùng bấm commit sau dry-run | ✗ | 0 |
| `import.rollback` | internal | người dùng | ✗ | 0 |

## 4. Template → allowed tools (trần)
| Template | allowed_tools |
|---|---|
| S1 Lead Sourcing | `web.search`, `web.fetch`, `signals.detect_tech`, `evidence.save`, `account.upsert_from_domain`, `candidate.create` |
| S2 Contact Finder | `contact.find` (workflow), `crm.read` |
| Q1 Qualification | `playbook.get`, `web.search`, `web.fetch`, `evidence.save`, `criterion.record_result`, `scorecard.finalize`, `card.propose_contact` |
| W1 Outreach Writer | `crm.read` (account, contacts, scorecard, supply profile), `email_draft.compose` |
| I1 Import Mapper | `import.propose_mapping` |
