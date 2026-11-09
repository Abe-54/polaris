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
Terminals use child endpoints of their Workspace binding. Sessions in subfolders resolve the same
containing Workspace/worktree checkout root as terminals. Turn intervals load
once, then update from the read model's recent Turns; a missed history window
causes a fresh history read.

To revoke every endpoint, stop the Daemon, delete `trace-tokens.json.seed` from
its home and restart it. The new seed invalidates all previous endpoints.
The pre-release hash-only vault migrates by revoking its old endpoints once;
subsequent restarts retain the derived endpoints.

Claude, Codex (including read-only configuration), and terminal processes receive
`OTEL_EXPORTER_OTLP_ENDPOINT` without a trailing slash. The trace and log signal-specific variables are also injected, so an existing
signal-specific target cannot bypass Polaris. Existing launch-environment targets become upstream collectors. Checkout-file targets remain suggestions until saved in Settings → Traces. The legacy `userExported` snapshot flag is false because a collector no longer prevents injection; existing clients keep the live endpoint. Reviewer environment allowlists
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

Span start time chooses the historical Turn interval; batch arrival never chooses
either attribution field. Managed Claude Bash commands on macOS/Linux receive a
per-command endpoint from the SDK `PreToolUse` hook (ENG-673). Its child token
contains the parent endpoint, a launch Turn id and a random nonce, authenticated
with the Daemon's private seed. The receiver verifies that signature, parent
revocation/checkout authority, and the Turn's membership in the bound Agent Session.
The token is stateless and survives graceful restart without retaining one vault
entry per command. A server launched in Turn 2 keeps `launchedTurn=2` while Spans
started during Turn 5 get `turn=5`; between Turns, `turn=null` and `launchedTurn=2`.

The Bash hook sources a private 0600 environment file in a 0700 temporary directory,
so raw tokens never enter tool command text. Sourcing removes the file; Harness
scope close removes unused files. Preparation failure leaves the session endpoint
and unknown launch attribution. Polaris terminal opens also receive unique child
endpoints; user terminals have Workspace authority and `launchedTurn=null` because
no Agent Session Turn launched them. Commands typed into an interactive user shell
inherit that terminal's endpoint.

Codex agent, reviewer and TUI shell launches retain `launchedTurn=null`: the current
app-server contract exposes only thread-level `shell_environment_policy.set`, not
a per-command environment hook. Notifications cannot prove which environment a
child inherited. [ENG-691](https://linear.app/luxdev/issue/ENG-691) tracks enabling
this when Codex supplies a hook. Claude reviewer launches retain null to preserve
their checkout sandbox. Claude Subagent hooks have no verified owner-Turn binding
here, so they never borrow the foreground Turn. Claude In Terminal, Windows Bash,
OpenCode and ACP launches
also have no supported per-command injection here and remain null. Ordinary session
endpoints and process-supplied `polaris.launch.*` attributes cannot establish launch
authority. `environment.test.ts` pins Codex's null result, including reviewers.

Forwarding and Vercel duplicate-export detection are ENG-674 and ENG-675. No Engine
command, event-log semantics, protocol shape or model spec changes are required.

Run `bun test apps/daemon/src/traces` with native loopback/PTY access. The
`packages/bench` `traces` scenario drives 200k Spans through the real Daemon,
measuring ingest throughput, RSS, concurrent RPC latency and worker retirement.
ENG-673's default-timeout checks, negative control and raw paired measurements
are in [launch measurements](../../../../packages/bench/measurements/eng-657/launch/README.md).

MCP `traces`, `trace`, `span`, `trace_stats`, `trace_capture`, `trace_errors` and `trace_compare` share these services on every Data-tool binding. In the Polaris
Workspace, while Developer Mode is effective, they also read the Self-Trace scope (`scope: "self"`,
ENG-731).
`TraceStore.history(checkout, tracePrefix)` batches root and Span-name/parent-name duration medians
over earlier retained traces; fewer than five samples produce no baseline. The read-only helper
runs inside the existing worker and also returns each Span's actual sample count.
`traces.get` attaches `usual: { [spanId]: { usualMs, samples } }` from one history call;
older Daemons may omit it. Desktop uses the same SLOW rule (over 20 ms and over three times
the median), and FAST when below a third of a median over 20 ms. Both require five samples.
No baseline means no badge or panel line. Folded sums have no per-call verdict.
The MCP summary retains error paths before the critical path, collapses repeated siblings, and
counts omitted Spans under the text cap. Its full contract is `docs/specs/traces-tools-v1.md`.

`TraceStore.stats(checkout, filter)` (`stats.ts`, ENG-746) backs MCP `trace_stats`: Spans
started since `sinceMs`, optionally by name substring, service and status, grouped by name
and/or service with count, errors, nearest-rank p50/p95, max, latest start and an example Span
(the newest errored one, else the slowest). It range-scans `spans_retention (checkout, age)`
newest first, or `spans_age` with a status filter, so no new index or ingest cost; at most
20,000 matching Spans are read, and a capped result reports where its read stopped. It runs in
the store worker after the usual prune, and reads one scope: the checkout or `polaris:self`.

`TraceStore.capture(checkout, filter)` (`capture.ts`, ENG-748) backs MCP `trace_capture`: the
Spans that started between `sinceMs` and `untilMs`, optionally by name substring, oldest first
over `spans_retention (checkout, age)` with no sort, at most 500 (more is `truncated`).
`TraceStore.changes` subscribes in the caller's scope and wakes on each worker write or
`notify`; the tool's `until` check waits on it rather than polling, so nothing runs outside a
call. The blocking, the grace for late batches (2.5 s self, 5.5 s checkout) and the trace trees are
in `mcp/sessions/capture.ts` and `mcp/tools/captureFormat.ts`; the contract is
`docs/specs/traces-tools-v1.md`.

`TraceStore.errors(checkout, filter)` (`errors.ts`, ENG-750) backs MCP `trace_errors`: error
Spans since `sinceMs` grouped by `fingerprint(message)`, the message's first line with quoted text,
URLs, UUIDs, paths, hex and random ids and numbers replaced. It range-scans `spans_age (checkout,
status, age)` with `status='error'` under the same 20,000-Span cap, reading the status message (or
the first exception event's message) with `json_extract`, so nothing new is stored at ingest.

Attribute filters (`attributes.ts`, ENG-753) are `json_extract(value, ?) IN (?, ?)` clauses whose
JSON path is a bound parameter; keys are limited to `[A-Za-z0-9_.:-]` so the path can't be escaped.
In `stats` they and the `attribute` group key ride the same window scan. `toolList(checkout,
filter, attributes)` has no window, so it matches only the checkout's newest 20,000 Spans, read off
`spans_retention` before the filter, and its page carries `coveredSince` when that cut anything.

`TraceStore.spanCompare(checkout, filter)` (`spanCompare.ts`, ENG-751) backs MCP `trace_compare`:
two `scanGroups` reads (the `stats` scan without its group limit, each side under its own cap, with
`untilMs` as `age<?` and `version` matched against the resource's `service.version`), diffed by
name and service into appeared, disappeared and changed groups, scored on share of spans, error
rate and p95. Self-Traces carry `service.version` from each process's build (`self/tracer.ts` for
the Daemon).

## Phase 2 contracts (ENG-657)

`packages/protocol/src/traces.ts` owns these additive contracts. The phase 1
shapes and `traces` capability are unchanged. Settings and comparison are implemented
and advertised as `traces.settings` and `traces.compare`. Profiles supplies all three
of its handlers and `traces.profiles`; see `profiles/README.md`.
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
`TraceTurn`. Optional `origin` (`command`, `restart`, `attach`) says how it was
recorded and optional `service` names the process's `service.name`; older Daemons
omit both and Clients fall back to the Turn and status. `ProfileDetail.hotFunctions` contains self and inclusive milliseconds
and nullable file/line for unresolved frames. Its indices remain stable when a UI
sorts a view by self time. `hotPath` indexes those functions from root to leaf;
each flame chart node indexes a function and an earlier parent (null for roots),
with start/duration in milliseconds relative to `profile.startedAt`. P4 must
validate parsed indices and timings. Restart revalidates Polaris's process launch
identity and checkout ownership; a caller-supplied pid alone is never authority.

Compare selectors are tagged `{_tag: "Turn", turnId}` or
`{_tag: "Trace", traceId}` (full id or unique prefix). The Daemon resolves both in
the session's checkout. `a` is before and `b` after. Additive `{_tag: "Baseline"}`
is valid only as `a`,
against a Turn `b`; it explicitly selects that route's earlier attributed traces
within retention in this checkout. A trace belongs to Baseline only when its
root Span starts before the target Turn's start. Omitted MCP `a` means Baseline; equal explicit selectors compare with themselves. Turn
selectors resolve in the caller's Agent Session; Trace selectors resolve in its
checkout. Additive `{_tag: "Turns", firstTurnId, lastTurnId}` selects every Turn
from the first through the last in session order (a user Turn and its
continuations) and pairs wherever Turn does; `compare.ts` resolves it to Turn ids
for the worker, and Baseline starts before its first Turn. Baseline as `b`, mixed
explicit selector types, Baseline against a Trace and a reversed range return
`E-INPUT` with accepted input forms. This is the Lead's owner decision
for ENG-660; it supersedes the original contract's absence of a baseline mode.
Routes are grouped by service and Trace root name, sorted by service then route.
Each side has retained Trace count and nearest-rank `p50Ms`/`p95Ms`; fewer than
three complete retained samples on either side means "no baseline":
both sides retain their counts with null percentiles. A missing route side has
count zero. Partial traces are excluded and reported in optional per-route
`partial:{before,after}` counts. A missing local root counts as partial for
comparison. Prefer the earliest parentless root, then a server/consumer Span
whose parent is not retained locally, then the earliest Span for attribution.
Optional `slowestNew:{name,service,durationMs,traceId,spanId}`
identifies the longest after Span whose service/name/parent-name is absent from
the same before root route. RPC and MCP return these same facts. The separate
`compareQuery.ts` runs only on demand inside the existing SQLite worker, after
retention, without pins, timers or the history helper's five-sample SLOW rule.
Each comparison holds a private WAL read snapshot and yields between bounded
candidate pages and signature-cursor batches, so ingest and other reads can
progress. Signature lookup reuses the indexed name/parent-name history columns;
a small partial index handles the parentless-root ingest path.
A missing selector still uses `TraceError`
rather than silently comparing another Turn or checkout. P8 owns aggregation,
expiry/partial-data handling and selector authorization.

## Forwarding and Workspace settings (ENG-674, ENG-675)

`TraceSettings` owns registered-Workspace settings and private launch-time target resolution.
`traces.settings` and `traces.setSettings` share this service. Patches persist atomically in
`trace-settings.json` (0600); detection, exporter header values and inferred collector URLs
are never persisted. Launch-environment OTLP collectors take precedence over the saved
Workspace target, then launch-environment vendor collectors. Destination and credentials are
resolved from the launch environment and checkout `.env*` files separately; they never mix.
File-derived OTLP and vendor collectors are suggestions only: Polaris sends nothing to them
until the user saves their URL as `forwardTo` in Settings → Traces. File-derived credentials
are never attached to a saved target. Incoming credentials stay with the launch collector's origin.
Within an environment, a signal-specific endpoint is used verbatim; a general endpoint gets
`/v1/traces` or `/v1/logs` appended. The Workspace field is a full traces URL. Clearing it
suppresses launch vendor fallback; an explicitly exported OTLP endpoint still wins. The
forwarding switch overrides every source. The public `forwardTo` describes the effective target;
repository discovery remains evidence in `detectedExporters`, with an unsaved suggestion caption.

`forwarding-sources.test.ts` sends through the real receiver, store and forwarding queue to
loopback HTTP collectors. It covers a repository `AXIOM_URL` with launch-only credentials,
unsaved OTLP/vendor endpoints, saved targets and launch-only vendor forwarding. Only Axiom's
default remote service is replaced at the fetch boundary; no live vendor receives test data.

Discovery reads at most 16 regular files of 64 KiB, scans at most 256 directory entries,
refuses symlinks, and never executes checkout code or expands environment expressions.
Mode-specific `.env.<NODE_ENV>.local`, `.env.local`, `.env.<NODE_ENV>` and `.env` precede
other `.env*` files; example/sample/template files are excluded. Detection refreshes on launch,
without watchers or timers. Per-launch private targets are memory-only; after a Daemon restart,
authenticated traffic re-resolves automatic targets from the Daemon environment. Checkout
files still supply detection evidence, never automatic forwarding authority.
Configured headers override incoming app headers. Incoming credential-bearing headers and
all non-transport names from launch OTLP header variables pass only to the original launch collector's
origin (scheme, host and port); another origin gets only non-credential app headers.
Framing and hop-by-hop headers are removed. Settings lists configured header names plus
launch OTLP header names for a matching origin, excluding transport headers;
`passesAppHeaders` tells Desktop that additional app headers can pass without observing them.

Compiled Daemons disable Bun's cwd `.env` and `bunfig.toml` autoloading, preventing repository
configuration from entering the trusted launch environment before detection. Build with
`bun scripts/build-daemon.ts darwin-arm64`, then run
`bun apps/daemon/src/main.ts lease bench -- bun apps/daemon/src/traces/compiled-environment.smoke.ts apps/daemon/dist/darwin-arm64/polaris`.
The smoke starts that binary in a scratch directory containing both startup files, checks
forwarding resolution and a child process environment, and rejects a preload side effect.
Passing `dev` instead runs the supported shell development launcher and must pass the
same checks. Passing `unsafe-dev` retains the prior direct source invocation and must
fail with the repository URL, child sentinels and preload marker visible (negative control).
Run both probes with
`./scripts/daemon-dev.sh lease bench -- bun --no-env-file --config=./scripts/daemon-dev.toml apps/daemon/src/traces/compiled-environment.smoke.ts dev`
(replace `dev` with `unsafe-dev` for the negative control).
See [Daemon development startup](../../README.md) for safe watch/package entrypoints and
the limits of direct invocation and already contaminated parent environments.

Axiom packages produce evidence; launch `AXIOM_TOKEN`/`AXIOM_DATASET` select its OTLP
traces target. Vercel packages and exporter environment produce evidence; launch `VERCEL_OTEL_ENDPOINTS` prefills the platform's
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

## Self-Traces (ENG-710, ADR 0095)

`self/` holds Polaris's own Spans. `serve` installs `selfTracer` as the root Tracer. While
`DeveloperModeState` (from `developerMode/service.ts`) is not effective, its `span` is the native
tracer's, so there is no exportable Span, buffer or store worker wake-up. `selfTraceExport`
follows the state's `changes`. While it is effective, ended sampled Spans wait in memory and go
to the store as `polaris-daemon` once 64 are waiting, when a read includes the Self-Trace scope,
on a switch (to the old sink) or at shutdown. There is no timer, so a lone Span never wakes the
store's worker. Connection upkeep (`QUIET_SPANS`: hello, `authenticateConnection`,
`presence.report`, `developerMode.lease`) and the Spans under it are never exported, so an idle
Host's Clients don't keep that worker alive (ENG-721).

Self-Spans become OTLP JSON and go through `TraceStore.ingest`: the same decoder, redaction and
bounds as the receiver. They are stored under the reserved checkout key `polaris:self`, which is
not a path. That scope has its own retention of 50 MiB or 24 hours (`self/scope.ts`), separate
from checkout budgets. `traces.ingestSelf` refuses with `developer-mode-off` unless Developer Mode
is effective, and with `busy` when the store is busy (Clients retry that batch). It drops Spans that end before they start and stamps the batch's `service` as
`service.name`. The protocol schema bounds a batch to 1,024 Spans and 512 KiB.

`traces.watch/get/span` read the session's checkout and, when its Workspace is
`polarisWorkspaceId`, the Self-Trace scope too. Pages are merged newest first, and a prefix
resolves in the checkout first. `scope: "self"` reads only the Self-Trace scope. The session
still authorizes the read, and the first page carries no endpoint.

`transport/traceContext.ts` rebuilds Effect's request `traceId`/`spanId`/`sampled` from the
`traceparent` header alone, so a handler Span is the child of the Client Span that sent it.
Effect's own client fields are never trusted. No trace context leaves the Daemon:
`harnessEnv` is unchanged and still strips `POLARIS_OTEL_*`.

### Source-mapped stacks (ENG-752)

An error Span's `statusMessage` is `Cause.pretty`, stack included. The compiled Daemon embeds a
sourcemap (`scripts/daemonBundle.ts`: `sourcemap: "linked"` under `--compile`), which Bun 1.4.4
stores zstd-compressed in the executable and applies to `Error.stack` itself when a stack is
formatted, so frames read `at m_ (apps/daemon/src/transport/serve.ts:408:14)` instead of
`at m_ (/$bunfs/root/chunk-pq4mf4p5.js:32:453)`. Nothing in `traces/` maps stacks, and the `span`
and `trace` MCP tools return what was stored. Function names stay minified (Bun's maps carry no
names); files, lines and columns are the source's. Paths are relative to the repo root, because
`buildFromRoot` builds with the cwd there and Bun writes sources relative to the cwd. The builder's
home never appears. Dependencies read as `node_modules/.bun/<pkg>@<version>/…`. The `.map` files
Bun also writes beside the binary are deleted, so none ship.

Cost, measured on darwin-arm64 (M2 Max): the binary grows 5.9 MB (128.8 → 134.7 MB, +4.5%;
Bun can't omit `sourcesContent`). Nothing is decompressed until a stack is formatted: `cold-start`
and `idle` against `--binary` (quick, 3 runs, A/B both orders) stayed within noise (settled
footprint 34.9 vs 34.9–36.4 MiB, idle no-Client footprint 41.3 vs 41.5 MiB). The first mapped
stack costs about 0.5–1 MiB peak RSS.

The Desktop App doesn't need this yet: its Spans (`packages/client/src/selfTraces/span.ts`, the
renderer's `features/selfTraces`) export the error's message only, never a stack. Electron's main
process (Node) maps `Error.stack` only with `--enable-source-maps` or `setSourceMapsEnabled`, and
Chromium never maps a renderer's `Error.stack` (only DevTools does). So when Desktop Spans start
carrying stacks, main has to map them with the shipped `.map` files before export (ENG-755).
