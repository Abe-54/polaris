# Daemon Traces

`transport/serve.ts` composes one `TraceStore`, `TraceSessions`, `TraceRuntime` and
receiver per Host. The receiver binds only `127.0.0.1:4319`; failure leaves the
Daemon running and is exposed in `TracesSnapshot.availability`. It never takes
over another process's listener.

`TraceRuntime` issues a 256-bit endpoint token for an Agent Session or a Workspace
checkout. The token resolves checkout authority through the event store; resource
attributes cannot override it. Only hashes are saved, in `trace-tokens.json` with
mode 0600. Existing endpoints survive a Daemon restart. Harness scope close
revokes session endpoints; authentication also refuses archived, failed or missing
sessions and removed Workspaces. Terminals share a Workspace endpoint.

Claude, Codex (including read-only configuration), and terminal processes receive
`OTEL_EXPORTER_OTLP_ENDPOINT` without a trailing slash. Existing endpoint or
traces-endpoint variables suppress injection. Reviewer environment allowlists
retain endpoint variables but no exporter credentials; reviewer network policy
still blocks network access (ENG-676).

## Ingest and storage

`POST /otlp/<token>/v1/traces` and `/v1/logs` accept OTLP JSON or protobuf. Every
Origin is refused, Host is checked, bodies are limited to 4 MiB, and unsupported
content is drained before returning 415 so HTTP/1 keep-alive remains usable.
Compression is refused. Two concurrent requests and a 32-message worker queue
bound admission; overload returns 429. Successful protobuf responses are empty;
JSON responses are `{}`.

The lazy worker owns decoding, redaction, SQLite and retention. It exits after
30 seconds without requests, flushing first; an unused receiver has no worker
or polling timer. The generated OTel codecs are pinned behind `decoder.ts`.
Fixtures and real Node exporters exercise the wire mapping. A batch is limited
to 10,000 records, 32 nesting levels and 16 MiB of expanded records, including
resource attributes repeated per Span. Pending batches also have a 16 MiB cap.

Accepted records are flushed within 25 ms or immediately at 1,000 records.
The HTTP response acknowledges admission, not durable commit: a Daemon crash
before the flush can lose that short pending window. Queries flush first.
`traces.sqlite` is separate from the event log and contains only redacted data.
Sensitive attribute values use the literal JSON string `"[redacted]"`; keys stay
present, and nested values are redacted recursively. Exact nanoseconds and int64
attributes remain decimal strings.

Each checkout has a soft budget of 200 MiB of accounted records or seven days.
Error Spans and explicitly linked Traces survive pressure/age pruning; this can
exceed the soft budget. Start-time attribution alone does not pin a Trace. Pruned
Traces are marked partial. Incremental vacuum runs after active writes/pruning;
there is no idle sweep. SQLite allocation and indexes add overhead to accounting.

## Consumers

`TraceStore.list(checkout, filter?)` returns `{traces,total}`; `get(checkout,prefix)`
returns all retained Spans; `span(checkout,tracePrefix,spanPrefix)` returns the Span,
newest 20 correlated logs, and total log count. Prefixes fail on ambiguity and all
queries stay checkout-scoped. `link(checkout,tracePrefix)` pins explicitly; reads
never pin. `watch` emits an initial page then at most four updates per second.
The `traces.watch/get/span` RPCs resolve checkout from the selected Agent Session.

Span start time chooses the historical Turn interval. `launchedTurn` is null
until per-command process launch attribution is implemented (ENG-673). Forwarding
and Vercel duplicate-export detection are ENG-674 and ENG-675. No Engine command,
event-log semantics, or model spec changes are required for ingest.

Run `bun test apps/daemon/src/traces` with native loopback/PTY access. The
`packages/bench` `traces` scenario drives 200k Spans through the real Daemon,
measuring ingest throughput, RSS, concurrent RPC latency and worker retirement.

MCP `traces`, `trace` and `span` share these services on every Data-tool binding.
`TraceStore.history(checkout, tracePrefix)` batches root and Span-name/parent-name duration medians
over earlier retained traces; fewer than five samples produce no baseline. The read-only helper
runs inside the existing worker and also returns each Span's actual sample count.
`traces.get` attaches `usual: { [spanId]: { usualMs, samples } }` from one history call;
older Daemons may omit it. Desktop uses the same SLOW rule (over 20 ms and over three times
the median), and FAST when below a third of a median over 20 ms. Both require five samples.
No baseline means no badge or panel line. Folded sums have no per-call verdict.
The MCP summary retains error paths before the critical path, collapses repeated siblings, and
counts omitted Spans under the text cap. Its full contract is `docs/specs/traces-tools-v1.md`.

## Phase 2 contracts (ENG-657)

`packages/protocol/src/traces.ts` owns these additive contracts. The phase 1
shapes and `traces` capability are unchanged. New RPCs currently return
`Unsupported`; none of the three new capabilities is advertised. Each owner
replaces its handlers and advertises its capability when the implementation lands.
All six RPCs are local-Client-only, matching the phase 1 Traces access policy.
The new groups are `TracesSettingsRpcs`, `ProfilesRpcs` and `TraceCompareRpcs`,
merged into `DaemonRpcs` alongside the unchanged phase 1 `TracesRpcs` group.

| Capability | RPC payload | Result | Owner |
| --- | --- | --- | --- |
| `traces.settings` | `traces.settings {workspaceId}` | `WorkspaceTracesSettings` | P1/P3 |
| `traces.settings` | `traces.setSettings {workspaceId, settings}` | Complete settings after patch | P1/P3 |
| `traces.profiles` | `profiles.watch {sessionId}` | Replacement `ProfilesSnapshot {profiles}` stream | P4 |
| `traces.profiles` | `profiles.get {sessionId, profileId}` | `ProfileDetail` | P4 |
| `traces.profiles` | `profiles.restartWithProfiling {sessionId, pid}` | New `Profile` | P4 |
| `traces.compare` | `traces.compare {sessionId, a, b}` | `TraceComparison` | P8 |

Settings distinguish `enabled` (copy into Polaris) from `forwarding`. `forwardTo`
is null or `{url, headerNames}`: header values have no wire field, and public URLs
exclude userinfo, query strings and fragments. Actual credentials stay on the
Host. Implementers must omit credential-bearing URLs rather than serialize them;
the URL schema cannot identify a secret embedded in an otherwise ordinary path.
Updates are patches; omitted fields stay unchanged and null clears `forwardTo`.
`detectedExporters` is read-only evidence (`kind`, checkout-relative `file`,
one-based `line`, nullable `runtime`, `alreadyExporting`). Kinds are `axiom`,
`vercel`, `otlp-env`, `fixed-url`. `alreadyExporting` suppresses duplicate
forwarding (ENG-675). `autoInstrument` is `off`, `node` or `deno`;
`autoInstrumentOverride` bypasses Node SDK detection only. The read-only
`autoInstrumentSkipReason` explains skipped instrumentation. Bun is never
auto-instrumented, and an override never bypasses Workspace Trust.

Profiles use a store-assigned `ProfileId`; a path in a summary is display data,
never authority to read a file. `path` is null until a `.cpuprofile` exists.
`status` is `recording`, `completed` or `failed`, and `turn` is a nullable
`TraceTurn`. `ProfileDetail.hotFunctions` contains self and inclusive milliseconds
and nullable file/line for unresolved frames. Its indices remain stable when a UI
sorts a view by self time. `hotPath` indexes those functions from root to leaf;
each flame chart node indexes a function and an earlier parent (null for roots),
with start/duration in milliseconds relative to `profile.startedAt`. P4 must
validate parsed indices and timings. Restart revalidates Polaris's process launch
identity and checkout ownership; a caller-supplied pid alone is never authority.

Compare selectors are tagged `{_tag: "Turn", turnId}` or
`{_tag: "Trace", traceId}` (full id or unique prefix). The Daemon resolves both in
the session's checkout. `a` is before and `b` after, without an inferred baseline.
Routes are grouped by service and Trace root name, sorted by service then route.
Each side has retained Trace count and nearest-rank `p50Ms`/`p95Ms`; no samples
means count zero and null percentiles. A missing selector still uses `TraceError`
rather than silently comparing another Turn or checkout. P8 owns aggregation,
expiry/partial-data handling and selector authorization.
