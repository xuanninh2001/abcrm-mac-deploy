# Golden sets (Q1)

`*.jsonl` files here are read by the Q1 suite (`pnpm --filter @abcrm/evals eval --live`). Each line is one company,
labelled by a design partner (test-plan.md §5.1: `golden-insurance-200`, `golden-finance-100`, `golden-home-100`).

```json
{"pack":"insurance","playbook":"aca-fe-buyers","domain":"buyer.example","label":"fit",
 "account":{"hq_country":"US","employee_range":"51-200","verticals":["insurance"],"lead_types":[],"flags":[],"tech_signals":{"trustedform":{}}},
 "evidence":[{"id":"e1","kind":"web_page","url":"https://buyer.example/publishers","snippet":"…page text the engine saw…"}]}
```

- `label`: `fit` (a rep would want a card) or `not_fit` (wrong vertical, competitor, does not buy from publishers…).
- `evidence`: the page text S1 stored for the company (snapshot it once; the eval must not depend on live sites).
- Partner data stays private: do not commit real golden files to a public repository. CI reads them from a
  private location (`EVAL_GOLDEN_DIR`) when available.
- `examples/` holds a few made-up rows used by the unit tests; they are not counted in metrics.
