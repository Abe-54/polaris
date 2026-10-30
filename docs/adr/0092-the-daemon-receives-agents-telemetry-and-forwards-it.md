---
status: accepted
---

# The Daemon receives agents' telemetry and forwards it

## Context

Traces (⌘5, ENG-655) shows the OpenTelemetry traces and CPU profiles of code agents run, tagged
with the Agent Session and Turn that produced them, and gives agents tools to read them. That needs
a receiver, a way to get code to send to it, and an answer for apps that already send their
telemetry elsewhere (sightline exports to Axiom with the URL fixed in code). A network proxy
(Proxyman-style MITM) was considered and rejected: certificates, HTTP/2, websockets and pinning
cost far more than they add once instrumented apps report their own requests.

## Decision

**Each Host's Daemon runs an OTLP/HTTP receiver on loopback, injects its endpoint into the
commands Polaris launches, and forwards what it receives to the app's own collector.**

- **Receiver.** OTLP over HTTP (protobuf and JSON; traces and logs) on a fixed loopback port, not
  gRPC. The port is fixed because a dev server an agent started keeps the address it was given;
  an ephemeral port would drop its traces after a Daemon restart. The path carries a token
  (`/otlp/<token>`) per Agent Session, or per Workspace for Polaris terminals, as the MCP server
  does, with the same Host and Origin checks.
- **Injection.** `OTEL_EXPORTER_OTLP_ENDPOINT` goes into the per-session environment (the Claude
  process env; Codex's `shell_environment_policy.set`; the read-only allowlists) and into Polaris
  terminals. A value the user exported themselves is respected and becomes the forward target.
- **Attribution.** The token names the session; the Turn is the one in which a span started, and
  the span also records the Turn that launched its process.
- **Forwarding.** Polaris sits in the path and forwards the exact request, with the app's own
  headers, to the app's target (its environment, `.env*`, or the Workspace's "Forward traces to",
  prefilled from detected Axiom or Vercel exporters). Forwarding never waits on Polaris's store and
  a failed forward never drops our copy; the headers are never stored. A Workspace can turn it off.
- **Fixed exporters.** An exporter whose URL is a literal in code can't be redirected from the
  environment. We ask the app to read `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` with its URL as the
  fallback (one line, offered as an agent task) rather than patching exporters at runtime or
  pulling spans back from the vendor with the user's credentials.
- **Storage.** A separate per-Host SQLite file, never the event log: about 200 MB or 7 days per
  checkout, sampled under pressure but keeping every error span and every trace a Turn links.
  Sensitive attributes (authorization, cookies, tokens) are redacted on ingest.
- **Instrumentation.** Opt-in per Workspace, Node only, by `NODE_OPTIONS=--import` of a bundled
  register script, skipped when the project depends on an OpenTelemetry SDK (a preload can't know
  the app will register its own provider later, and the first registration wins). Deno gets
  `OTEL_DENO=true`. Bun is never auto-instrumented: it ignores `NODE_OPTIONS` and the Node
  instrumentations don't reach `Bun.serve`.
- **Profiles.** Whole-command `--cpu-prof` through `NODE_OPTIONS` or `BUN_OPTIONS`; a dev server is
  profiled by restarting it with the flag. Attaching to a running process needs the Node inspector,
  which lets any local process run code in the target, and kills a Bun process; that is deferred.

## Consequences

- The Daemon becomes a hop on the user's telemetry path; a Daemon restart drops at most what was
  in flight to the vendor.
- Apps started outside Polaris are invisible until the user points them at the endpoint.
- Every OTLP request is parsed on a Pi 4 too: the receiver batches writes and must justify itself
  in the bench's `idle` and high-span scenarios.
