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

Span start time chooses the historical Turn interval. `launchedTurn` is null
until per-command process launch attribution is implemented (ENG-673). Forwarding
and Vercel duplicate-export detection are ENG-674 and ENG-675. No Engine command,
event-log semantics, or model spec changes are required for ingest.

Run `bun test apps/daemon/src/traces` with native loopback/PTY access. The
`packages/bench` `traces` scenario drives 200k Spans through the real Daemon,
measuring ingest throughput, RSS, concurrent RPC latency and worker retirement.
