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
`OTEL_EXPORTER_OTLP_ENDPOINT` without a trailing slash. Existing endpoint or
traces-endpoint variables suppress injection. Reviewer environment allowlists
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
are in [launch-bench/README.md](./launch-bench/README.md).

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
shapes and `traces` capability are unchanged. Each owner replaces its default
`Unsupported` handlers and advertises its capability when the implementation lands.
`traces.compare` is implemented and advertised. Profiles supplies all three of its
handlers and `traces.profiles`; see `profiles/README.md`.
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
in the checkout, before the target Turn's start and within retention. Omitted
MCP `a` means Baseline; equal explicit selectors compare with themselves. Turn
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
`partial:{before,after}` counts. Optional `slowestNew:{name,service,durationMs,traceId,spanId}`
identifies the longest after Span whose service/name/parent-name is absent from
the same before root route. RPC and MCP return these same facts. The separate
`compareQuery.ts` runs only on demand inside the existing SQLite worker, after
retention, without pins, timers or the history helper's five-sample SLOW rule.
A missing selector still uses `TraceError`
rather than silently comparing another Turn or checkout. P8 owns aggregation,
expiry/partial-data handling and selector authorization.
