# Traces tools v1: the agent's contract

Polaris MCP tools for Traces (ENG-655, phase 1 ENG-656; ADR 0094; glossary in CONTEXT.md →
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
4f1c9a2e000000000000000000000000  POST /invoices/overdue   ledger-api   840 ms   434 spans   2 services   SLOW (usually 122 ms)
b07d11c3000000000000000000000000  test overdue-totals      bun          3.1 s     61 spans              1 ERROR: expected 1200, got 0
```

SLOW uses the median duration of the same root name over the most recent 50 earlier retained traces in this checkout.
At least five samples are required. Mark `SLOW (usually …)` only when duration is over 20 ms
and more than three times the median; otherwise omit both SLOW and `slow`. Never infer a baseline.

`structuredContent`: `{ traces: [{ id, root, service, durationMs, spans, services, errors, errorMessage?, turn, startedAt, slow?: {usualMs} }] }`.

Text prints full trace ids so a prefix collision outside this page cannot make a listed id ambiguous.
Root, service and error-message cells are clipped to 200 characters with a folded-character count.
Structured values retain their full length.

JSON reuses protocol types: `services` is an array of service names and `turn` is a nullable
`TraceTurn {sessionId, id, number}`. Text renders the service count and Turn number.

## `trace {id, focus?}`

One trace as a summarised tree. `id` is a full or unique-prefix trace id (≥ 8 hex). `focus`:
`"slow"` (default), `"errors"` or `"all"`.

- Header: root, duration, span count, services with span counts and summed Span time, Turn, error count.
  Service times overlap and are not wall-clock duration.
- Tree: indented two spaces per level; each line `offset  duration  name  [service where it
  changes]  [SLOW|ERROR]  span <unique-prefix>`. Span prefixes are at least eight hex
  characters and unique against all Spans in the trace, including folded ones.
- Repeated siblings (same name and parent) collapse to one line: `×214 GET /rates  p50 2.1 ms
  total 636 ms  (N+1?)`; the hint shows when one parent has more than 20 identical children.
  Error siblings collapse only when name, status, exception type and message match; their
  line keeps ERROR and one exception sample. Different failures remain separate.
- SLOW for a Span uses the median of the same Span name under the same parent name in earlier
  retained traces in this checkout, with the same five-sample, over-20-ms and over-3× rule.
  Use at most the 50 most recent observations per name/parent-name pair, ordered by trace start
  then Span start, strictly before this trace. A collapsed group compares its p50 with the usual
  duration, never its first member. Fetch indexed, bounded history once per Trace for all pairs.
- Order of keeping under the cap: error paths (root to each error span, with the exception type,
  message and top in-project frame), then the critical path (the chain of longest children), then
  the rest by duration. Reserve each error and its exception before its ancestors. Long paths
  retain the root and five nearest ancestors; intermediate levels may be folded. Render the
  retained set in depth-first start order for every focus. Visual indentation stops at 20 levels;
  compressed paths show the real depth and parent id. What's cut is said: `… 37 spans under 2 ms folded`.
- `focus: "errors"` keeps only error paths, or says `No error spans; use focus slow.`.
  `"all"` keeps the tree in start order, still protecting errors and the critical path under the cap.

```
POST /invoices/overdue · 840 ms · 434 spans · ledger-api 220, fx-rates 214 · turn 12 · 0 errors
+0 ms    840 ms  POST /invoices/overdue  ledger-api                 span 7c20e1b8
+12 ms   814 ms    invoices.recalculateOverdue                      span 2d91aa04
+60 ms   640 ms      ×214 GET fx-rates.internal/rates  p50 2.1 ms  total 640 ms  SLOW  (N+1?)
+61 ms   636 ms        ×214 GET /rates  fx-rates  p50 2.1 ms
+702 ms  112 ms      UPDATE invoices  SLOW (usually 9 ms)          span a91f03c2
… 9 spans under 20 ms folded
```

`structuredContent`: `{summary, spans, groups: [{spanIds}], folded: {count, underMs}}`. `summary`
is the retained Trace summary. `spans` contains one representative Span with full details per
displayed group, in display order; `groups` has the same order and every member id. Retrieve any
member with `span`. This bounds transferred Span details even when tens of thousands collapse
into a few groups. `folded.count` counts only Spans in undisplayed groups; `underMs` is a strict upper duration bound,
or zero when none are folded. Selection priority and display order are separate: the tree always
uses start order, with two spaces per visible parent level up to the visual limit.

## `span {trace, span}`

One span in full: name, kind, service, status, duration, offset, parent, the Turn it ran in and
the Turn that launched its process; attributes grouped as the span panel shows them (`attributes`,
`polaris`, `resource`, `scope`), redacted values as `[redacted]`; events and exception stack (in-
project frames first); up to 20 log records written during it; links; the code location
(`code.file.path:code.line.number`); and for a database span, the matching Data Source name so the
agent can `describe` or `query` it.

`structuredContent`: `{span, logs, logCount, dataSource?: {id, name}}`. `span` is the retained
Span, `logs` are the newest 20 correlated records and `logCount` is the total retained count.
Resolve a database target through the Data Sources service using engine, server, port and database;
only a unique matching target gets `dataSource`. A null launched Turn has no launched-Turn text line.

## `compare {a?, b}` (ENG-660)

Selectors are `{_tag: "Turn", turnId}`, `{_tag: "Turns", firstTurnId, lastTurnId}`,
`{_tag: "Trace", traceId}` (full or unique prefix of at least eight hex characters),
or `{_tag: "Baseline"}`. Turns selects every Turn of the caller's agent session from
`firstTurnId` through `lastTurnId` in session order: one user Turn and the Harness
continuations that followed it, as Review groups them (ENG-660). It pairs wherever
Turn does. Omitted `a` means Baseline; `b` is required. Explicit pairs select two
Turns or Turn ranges in the caller's agent session, or two traces in its checkout.
The same explicit selector on both sides compares it with itself. Baseline is valid
only as `a`, against a Turn or Turns `b`; other combinations, and a range that ends
before it starts, return `E-INPUT` with the accepted forms. A range end outside the
session returns `E-TRACE-NOT-FOUND`.

The Lead's owner decision: for a Turn, before means the same service/root route's
traces in this checkout from earlier Turns within retention, and after means
that Turn's traces. Baseline includes attributed traces whose root Span starts before the
target Turn starts (a range's first Turn), across agent sessions in this checkout;
it excludes the target Turns, between-Turn traces, later traces and partial traces. Explicit pairs
use their selected traces instead of searching history. There is no sample cap
or implicit baseline outside Baseline mode. Reads never pin traces.

Group by root service and root span name, ordered by service then route. Show
nearest-rank p50 and p95 before → after, counts and the slowest new span per route.
Fewer than **three complete retained samples on either side** means `no baseline`:
preserve both counts and set both sides' percentiles to null. This also applies
to explicit trace pairs, which have one sample each. Empty known Turns produce
zero routes; unknown Turns or missing/expired trace selectors return
`E-TRACE-NOT-FOUND`. Assign a trace by its root Span, or its earliest Span only
when no root exists. A missing root makes the trace incomplete: exclude it from
statistics and semantic span comparison and count it in `partial`. A server or
consumer Span with an upstream parent and no retained local parent is a local
root. Retention runs before the comparison's read snapshot; ingest and other
reads can progress between its query chunks.

```
Route timings · retained traces only · 1 route
POST /invoices  ledger-api  p50 120 ms → 840 ms  p95 130 ms → 900 ms  runs 5 → 5
  slowest new span: invoices.recalculateOverdue  ledger-api  814 ms  trace 4f1c9a2e  span 2d91aa04
```

A sparse route reads `POST /invoices  ledger-api  no baseline  runs 2 → 5`.
A new span is a service/name/parent-name combination absent from the before
side of that same root route. Keep the longest individual after span, breaking
ties by trace id then span id. It is descriptive evidence even with no baseline,
never a claim that a code change caused a slowdown. No new span means no line.

`structuredContent` is the RPC's `TraceComparison {a,b,routes}`. Each route has
`{service,route,before:{count,p50Ms,p95Ms},after:{count,p50Ms,p95Ms},slowestNew?}`;
`slowestNew` is `{name,service,durationMs,traceId,spanId}`. Optional
`partial:{before,after}` counts partial traces excluded from statistics and span
comparison; text reports those exclusions. All retained routes remain in JSON.
Text is one block capped at 16,000 characters, with names clipped at code-point
boundaries and a count of
omitted routes; retrieve the full rows from compare structuredContent, and use
`trace` or `span` with the returned ids for detail.

## Caps and retrieval

All four tools emit one text block of at most 16,000 characters. `traces` states shown/total and
suggests limit or narrower filters. `trace` counts folded Spans and gives their upper duration
bound; use `span` for individual details. For `span`, name each omitted section with its omitted
detail-line count and say to use `span` structuredContent for the full retained data. Older logs
beyond the newest 20 are counted explicitly. Clip detail lines at 2,000 characters and budget
sections separately. Header/code, exceptions with in-project frames, and logs precede attributes,
resource and scope so a long SQL value cannot hide the failure. Structured Span details retain
redacted values at full length.

Every text and structured string is well-formed Unicode: lone surrogates become U+FFFD and bidi
overrides/isolates become spaces. Text additionally replaces C0 and DEL controls with spaces.
These presentation transformations do not change the retained records.

## Errors

| Code | When |
|---|---|
| `E-TRACE-NOT-FOUND` | no trace or span by that id in this checkout (expired, sampled out, or another checkout) |
| `E-TRACE-AMBIGUOUS` | an id prefix matches more than one trace |
| `E-TRACE-NONE` | nothing has reached the receiver for this checkout; fix names the endpoint and "Set up tracing" |

Unavailable services or receiver return `E-TRACE-UNAVAILABLE` with the reason and a fix pointing
to Traces (⌘5) and Set up tracing. Invalid input returns `E-INPUT` with input-schema guidance, including 8–32 lowercase hex for
trace ids and 8–16 lowercase hex for Span ids.
A filtered empty page returns zero traces; `E-TRACE-NONE` is reserved for an empty checkout and
its fix names the session endpoint and Set up tracing. Current means the active Turn in the calling
Agent Session; between Turns it selects unattributed traces. Explicit Turn numbers resolve only
within the caller's Agent Session; `all` spans all sessions in the checkout.

## `profile {command?, process?, id?, waitSeconds?}`

Exactly one selector is required. `command` is an argv array beginning with Node or Bun
(e.g. `["bun", "test", "invoice.test.ts"]`); it executes directly in the authenticated
session's verified cwd (including package subfolders), without shell expansion. Storage and
retention remain bound to the containing checkout root. `process` is the PID of a command this
Daemon's Profiles service launched; it restarts that command with CPU profiling.
`id` reads a retained recording. `waitSeconds` (1–120, default 30) bounds the wait for
a command, not its lifetime: a long-running command returns `recording` and stays owned
by the Daemon until it exits. Profiles are written on normal process exit; use `id` to
read the completed recording. Restart and Daemon shutdown send SIGINT; an owned
preload converts it to normal exit so Node and Bun flush their profiles. After five
seconds without exit, stop escalates to SIGTERM, then SIGKILL after five more seconds.
Shutdown drains completed artifacts. Restart reserves the replacement slot before
stopping and returns the new `recording` after the old recording is parsed.

Node receives `--cpu-prof` through `NODE_OPTIONS`, Bun through `BUN_OPTIONS`;
`--cpu-prof-dir` is passed as a single argv element so directories with spaces work.
The output directory is Daemon-owned and unique per recording under the checkout's
profile directory. Existing runtime options and the original upstream tracing settings
are preserved; each launch gets a fresh tracing overlay for the invoking Turn. No inspector attaches. A PID is never authority: only a live retained
subprocess handle and the same canonical checkout authorize restart. Restart revalidates
that the original cwd still resolves inside this checkout and the workspace is still trusted. Unknown PIDs,
user shells and processes from a previous Daemon return `E-PROFILE-PROCESS-NOT-OWNED`:
"Polaris didn't start this process"; the fix tells the agent to ask the user before
restarting it. No command or restart is retried automatically.

The single text block (at most 16,000 characters) starts with status, runtime, duration,
profile id and the verified execution directory (`Profile.cwd`). A completed recording shows hot functions ranked by self time and by
total time, in-project files first in each view, with `file:line`; the hottest stack;
the absolute `.cpuprofile` path; and retained traces whose spans overlap the recording's
wall-clock window. Lists state omitted counts and point to the full recording in Traces (⌘5).
No overlap is a valid empty list, and never implies the command exported traces.

`structuredContent` is at most 16,000 UTF-8 JSON bytes. Completed recordings return
`{profile, hotFunctions, totalFunctions, hotPath, traces, functionCount, nodeCount,
hotPathCount, traceCount, detail}`. The function rankings lead with self and total
time respectively. Frame rows include `index`, `name`, `file`, `line`, `selfMs` and
`totalMs`; `index` refers to the full function table. Hot-path rows use the same shape.
Labels/metadata are clipped to 256 characters, arrays have byte budgets, and counts
refer to the unabridged results. Chronological nodes are omitted. The separate
`profiles.get` RPC serves the full `ProfileDetail` for the Desktop App or an explicit
Client read. Recording/failed results return bounded `{profile}` metadata.
`origin` is `command` or `restart`; `service` is the launch environment's `OTEL_SERVICE_NAME`
when present, falling back to the instrumentation overlay's `POLARIS_OTEL_SERVICE_NAME`.
Parsing and aggregation run in a worker, including 50 MB inputs.
Overlapping traces are capped at 200, with their full retained match count in `traceCount`.
Retained recordings follow the trace store's seven-day retention and a separate 200 MiB
per-checkout budget covering raw artifacts and parsed details of finished recordings.
Active recordings do not consume the retention budget. Four live recordings/starts
are allowed per Host; parsing does not consume a slot. The refusal names that limit.
Completion jobs wait for queue space; list/get recover orphan flushed artifacts.
Prune on access and completion; no idle polling. A single artifact over 64 MiB is
refused. Reads never pin.

Errors use the same `{code,message,fix}` envelope. `E-PROFILE-INVALID` means an unsupported
command or malformed/oversized artifact; `E-PROFILE-NOT-FOUND` means an expired or foreign
id; `E-PROFILE-UNAVAILABLE` means capture/storage unavailable; `E-PROFILE-RESTART-REFUSED`
means execution policy refused the command, its directory changed, or the owned process
could not stop within the restart deadline. Its fix names the required action.
