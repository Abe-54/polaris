# Traces tools v1: the agent's contract

Polaris MCP tools for Traces (ENG-655, phase 1 ENG-656; ADR 0092; glossary in CONTEXT.md →
Traces). On every binding beside the Data tools (`docs/specs/data-tools-v1.md`), with the same
shared rules: the Daemon resolves the caller's Agent Session, checkout and Turn; output is one text
block capped at 16,000 characters plus `structuredContent`; errors are `{code, message, fix}`.

The point is that a trace reaches an agent already read: a 434-span trace becomes a page that
says where the time went and what failed, not 434 lines.

## `traces {turn?, route?, service?, status?, minMs?, limit?}`

Traces from the caller's checkout, newest first. `turn`: a Turn number, `"current"` (default) or
`"all"`; `route` a glob on the root span name (`POST /invoices*`); `status` `"error"` or `"ok"`;
`minMs` a duration floor; `limit` ≤ 50 (default 20).

```
Turn 12 · 14 traces (2 shown of 14; add limit)
4f1c9a2e  POST /invoices/overdue   ledger-api   840 ms   434 spans   2 services   SLOW (usually 122 ms)
b07d11c3  test overdue-totals      bun          3.1 s     61 spans              1 ERROR: expected 1200, got 0
```

`structuredContent`: `{ traces: [{ id, root, service, durationMs, spans, services, errors, turn, startedAt, slow?: {usualMs} }] }`.

## `trace {id, focus?}`

One trace as a summarised tree. `id` is a full or unique-prefix trace id (≥ 8 hex). `focus`:
`"slow"` (default), `"errors"` or `"all"`.

- Header: root, duration, span count, services with span counts and time, Turn, error count.
- Tree: indented two spaces per level; each line `offset  duration  name  [service where it
  changes]  [SLOW|ERROR]  span <8-hex>`.
- Repeated siblings (same name and parent) collapse to one line: `×214 GET /rates  p50 2.1 ms
  total 636 ms  (N+1?)`; the hint shows when one parent has more than 20 identical children.
- Order of keeping under the cap: error paths (root to each error span, with the exception type,
  message and top in-project frame), then the critical path (the chain of longest children), then
  the rest by duration. What's cut is said: `… 37 spans under 2 ms folded`.
- `focus: "errors"` keeps only error paths; `"all"` keeps the tree in start order, still capped.

```
POST /invoices/overdue · 840 ms · 434 spans · ledger-api 220, fx-rates 214 · turn 12 · 0 errors
+0 ms    840 ms  POST /invoices/overdue  ledger-api                 span 7c20e1b8
+12 ms   814 ms    invoices.recalculateOverdue                      span 2d91aa04
+60 ms   640 ms      ×214 GET fx-rates.internal/rates  p50 2.1 ms  total 640 ms  SLOW  (N+1?)
+61 ms   636 ms        ×214 GET /rates  fx-rates  p50 2.1 ms
+702 ms  112 ms      UPDATE invoices  SLOW (usually 9 ms)          span a91f03c2
… 9 spans under 20 ms folded
```

## `span {trace, span}`

One span in full: name, kind, service, status, duration, offset, parent, the Turn it ran in and
the Turn that launched its process; attributes grouped as the span panel shows them (`attributes`,
`polaris`, `resource`, `scope`), redacted values as `[redacted]`; events and exception stack (in-
project frames first); up to 20 log records written during it; links; the code location
(`code.file.path:code.line.number`); and for a database span, the matching Data Source name so the
agent can `describe` or `query` it.

## Errors

| Code | When |
|---|---|
| `E-TRACE-NOT-FOUND` | no trace or span by that id in this checkout (expired, sampled out, or another checkout) |
| `E-TRACE-AMBIGUOUS` | an id prefix matches more than one trace |
| `E-TRACE-NONE` | nothing has reached the receiver for this checkout; fix names the endpoint and "Set up tracing" |
