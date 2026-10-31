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
