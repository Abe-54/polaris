# Daemon Traces

`transport/serve.ts` composes one `TraceStore`, `TraceSessions`, `TraceRuntime` and
receiver per Host. The receiver binds only `127.0.0.1:4319`; failure leaves the
Daemon running and is exposed in `TracesSnapshot.availability`. Binding retries
with exponential backoff from 250 ms to 30 seconds while unavailable; a listening
receiver has no retry timer. It never takes over another process's listener.

`TraceRuntime` derives a 256-bit endpoint token for an Agent Session or Workspace
checkout with HMAC-SHA256 over its binding and revocation epoch. A random 256-bit
seed lives in `trace-tokens.json.seed` under the Daemon home (0600); the seed and
raw tokens never enter the event log, errors or persisted bindings. Tokens are
compared in constant time. `trace-tokens.json` holds one entry per binding with
its epoch and active flag, plus current sessions' exporter preferences (0600).
Revoked entries retain their epoch so later re-issue cannot revive an old token.

The event store owns authority. Archived or failed sessions and removed Workspaces
revoke their bindings and prune exporter preferences. The lifecycle subscriber
also reconciles on startup; authentication rechecks authority before ingest.
Dormancy, Harness scope close, graceful restart and upgrade preserve endpoints.
Terminals share a Workspace endpoint. Sessions in subfolders resolve the same
containing Workspace/worktree checkout root as terminals. Turn intervals load
once, then update from the read model's recent Turns; a missed history window
causes a fresh history read.

To revoke every endpoint, stop the Daemon, delete `trace-tokens.json.seed` from
its home and restart it. The new seed invalidates all previous endpoints.
The pre-release hash-only vault migrates by revoking its old endpoints once;
subsequent restarts retain the derived endpoints.

Claude, Codex (including read-only configuration), and terminal processes receive
`OTEL_EXPORTER_OTLP_ENDPOINT` without a trailing slash. The trace and log signal-specific variables are also injected, so an existing
signal-specific target cannot bypass Polaris. Existing targets become upstream collectors. The legacy `userExported` snapshot flag is false because a collector no longer prevents injection; existing clients keep the live endpoint. Reviewer environment allowlists
retain endpoint variables but no exporter credentials; reviewer network policy
still blocks network access (ENG-676).

## Ingest and storage

`POST /otlp/<token>/v1/traces` and `/v1/logs` accept OTLP JSON or protobuf. Every
Origin is refused, Host is checked, and method, path, token and content type are
validated before admission. Refusals close the connection without draining a
slow body. Bodies have a 4 MiB limit and a five-second total deadline. Compression
is refused. Two concurrent requests, at most one per token, and a 32-message
worker queue bound admission; overload returns 429. Successful protobuf responses are empty;
JSON responses are `{}`.

The lazy worker owns decoding, redaction, SQLite and retention. It exits after
30 seconds without requests, flushing first, then calls `releaseMemory` to return
allocator pages; an unused receiver has no worker or polling timer. The generated OTel codecs are pinned behind `decoder.ts`.
Fixtures and real Node exporters exercise the wire mapping. A batch is limited
to 10,000 records, 32 nesting levels and 16 MiB of expanded records, including
resource attributes repeated per Span. Pending batches have a 16 MiB cap and an 8 MiB allowance per checkout. Each
record is serialized once for admission accounting and SQLite writes.

Accepted records are flushed within 25 ms or immediately at 1,000 records.
The HTTP response acknowledges admission, not durable commit: a Daemon crash
before the flush can lose that short pending window. Queries flush first.
`traces.sqlite` is separate from the event log and contains only redacted data.
Storage failures answer 503, retain pending batches transactionally, and retry
on the next request; a failed quiet flush keeps the worker alive. Only forced
shutdown or a worker crash can lose that acknowledged, undurable window.

Sensitive attribute values use the literal JSON string `"[redacted]"`; keys stay
present, and nested values are redacted recursively. SQL passwords, CLI flags
(including joined `process.command_args`), environment assignments, common vendor
tokens, status messages and log bodies are scrubbed. Opaque `bytesValue` values
are replaced rather than persisted. URL-specific redaction changes userinfo and
sensitive query values only, preserving schemes, hosts, paths, ordinary parameters
and ESM frame locations. Exact nanoseconds and int64
attributes remain decimal strings.

Each checkout has a soft budget of 200 MiB of accounted records or seven days.
Ordinary records are removed first under pressure; errors may use up to twice
the byte budget, then the oldest unpinned records are removed. Every unpinned
record ages out, including errors. Explicitly linked Traces survive both limits
and can exceed the budget. Start-time attribution alone does not pin a Trace. Pruned
Traces are marked partial. Incremental vacuum runs after active writes/pruning;
there is no idle sweep. SQLite allocation and indexes add overhead to accounting.

## Consumers

`TraceStore.list(checkout, filter?)` returns `{traces,total}`; `get(checkout,prefix)`
returns all retained Spans; `span(checkout,tracePrefix,spanPrefix)` returns the Span,
newest 20 correlated logs, and total log count. Prefixes fail on ambiguity and all
queries stay checkout-scoped. `link(checkout,tracePrefix)` pins explicitly; reads
never pin. `watch` emits an initial page then at most four updates per second.
The `traces.watch/get/span` RPCs resolve checkout from the selected Agent Session.
Only the first watch page includes the endpoint; later pages set it to null.
Clients keep the initial endpoint separately in memory and never persist it.

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
shapes and `traces` capability are unchanged. P1 implements and advertises `traces.settings`; profile and compare RPCs remain
owned by their respective implementation lanes. Each owner
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

## Forwarding and Workspace settings (ENG-674, ENG-675)

`TraceSettings` owns registered-Workspace settings and private launch-time target resolution.
`traces.settings` and `traces.setSettings` share this service. Patches persist atomically in
`trace-settings.json` (0600); detection, exporter header values and inferred collector URLs
are never persisted. Source environment takes precedence over checkout `.env*`, then the
Workspace target, then vendor suggestions. Within an environment, a signal-specific endpoint
is used verbatim; a general endpoint gets `/v1/traces` or `/v1/logs` appended. The Workspace
field is a full traces URL. Clearing it suppresses vendor suggestions; an explicitly exported
or file-defined endpoint still wins. The forwarding switch overrides every source.

Discovery reads at most 16 regular files of 64 KiB, scans at most 256 directory entries,
refuses symlinks, and never executes checkout code or expands environment expressions.
Mode-specific `.env.<NODE_ENV>.local`, `.env.local`, `.env.<NODE_ENV>` and `.env` precede
other `.env*` files; example/sample/template files are excluded. Detection refreshes on launch,
without watchers or timers. Per-launch private targets are memory-only; after a Daemon restart,
authenticated traffic re-resolves from the Daemon environment and current checkout files.
App headers received with a request always override configured environment headers.

Axiom packages and `AXIOM_TOKEN`/`AXIOM_DATASET` prefill its OTLP traces target. Vercel packages
and exporter environment produce evidence; `VERCEL_OTEL_ENDPOINTS` prefills the platform's
loopback collector (port 4318 or its configured port). `@vercel/otel` with a direct imported
`registerOTel` call, an explicit exporter constructed with a known separate HTTP(S) URL, and automatic processors is marked already
exporting. Its incoming spans are stored without forwarding a duplicate. Syntax analysis
ignores comments, strings and unrelated calls. Dynamic/spread configurations, unresolved exporter variables and custom processor lists
without `"auto"` are not inferred. An exporter reading an injected OTLP variable is never
classified as already sending to the vendor. Fixed-exporter suggestions and automatic
instrumentation are P3's separate helpers; `recordInstrumentation` accepts their read-only
skip reason and evidence. P1 persists the requested auto-instrumentation fields.

The receiver enqueues raw bytes and the original content type before calling the existing
store. It never serializes/redacts a forwarded payload. A failed collector cannot drop local
storage, and a blocked store cannot delay the collector. `enabled` controls local storage
independently of `forwarding`. A patch turning forwarding off cancels queued requests and
retries; a request already delivered cannot be recalled. No second receiver or store is created.

Each receiver's `ForwardQueue.stats` counts delivered requests, failures and dropped requests.
The queue caps pending/in-flight entries at 32 and 8 MiB of body, URL and header accounting,
dropping oldest first. An aborted in-flight fetch can retain its body until cancellation completes
in addition to the queue cap (at most one 4 MiB body). One request is sent at a time, with a
five-second timeout and at most five attempts; network/429/5xx retries back off from 250 ms
up to 30 seconds. Redirects are not followed; connection/framing headers are regenerated.
There is no timer when the queue is empty. All raw bodies/headers are memory-only and dropped
on close. Collector exceptions and credentials are never logged. Public inferred URLs expose
only `/` or `/v1/traces` paths, with no userinfo, query or fragment; other paths may contain
credentials and are omitted from settings even though the private target remains usable.

`POLARIS_BENCH_TRACE_FORWARDING=down bun run bench traces ...` enables forwarding to an
unavailable loopback collector for the existing scenario; its notes record this mode. It uses
the same receiver/store and baseline metrics. The idle scenario leaves the queue unused.
