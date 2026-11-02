---
status: accepted
---

# Self-Traces travel in the Polaris protocol

## Context

Developer Mode makes Polaris trace itself: the Daemon, the Desktop App (main and renderer) and the
Mobile App each emit Self-Traces, which appear with the Traces of the Workspace that holds
Polaris's own code. That Workspace may live on a remote Host, and the Mobile App reaches Hosts
only through the relay. The Daemon's OTLP receiver (ADR 0094) listens on loopback and accepts
only tokens bound to a live Agent Session or checkout.

## Decision

**Clients send Self-Traces to the Daemon over the Polaris protocol, and every RPC frame carries
W3C trace context, so one Turn is one Trace from the composer to the Harness.**

- **Ingest.** A Client sends batches of Self-Trace Spans through a new RPC to the Host that holds
  the Polaris Workspace; the Daemon writes them as it writes OTLP Spans, under the Self-Trace
  scope. Its own Spans go straight to the store.
- **Propagation.** Frames carry `traceparent` (and `tracestate`) as optional wire metadata, so a
  Daemon Span is a child of the Client Span that sent the command.
- **Action Spans.** In the Desktop App each user action (a command run, a tracked click, a
  navigation) is a root Span, `polaris.action.<id>`, labelled with no user content. While it is
  open, renderer IPC requests without a trace of their own carry its trace, so main's `ipc.*` Span
  and the Daemon's Spans nest under it. It ends when its handler has returned and its requests
  have settled, plus 50 ms of quiet so the requests a click's React effects start still join; a
  3 s bound ends it regardless, so a slow load or a stuck request can't hold it. Requests unrelated
  to the action that land in that window join it too; that is accepted for one place to look.
- **Bounds.** A Client buffers at most 1 MiB or 5 minutes of Spans while the Host is unreachable
  and drops the oldest past that. Self-Traces have their own retention, smaller than a
  checkout's.
- **Switching.** The Host stores Developer Mode; every process checks it live, with no restart.
  When it is off, no Span is exported and frames carry no trace context.
- **Development builds.** Polaris Dev and a Daemon run from source are always on. Polaris Dev
  holds a lease on each Host it connects to rather than writing the stored setting, so a Daemon
  traces while the setting is on or any Client holds a lease. The release app and the Mobile App
  keep showing the stored value, and tracing stops when Polaris Dev disconnects.

## Considered Options

- **OTLP/HTTP straight from each Client to the Daemon's receiver.** This reuses ADR 0094's path, but
  it reaches only the local Daemon, leaves the Mobile App out, and needs a token that isn't bound
  to a checkout. It also can't link a Client Span to the Daemon work it caused.
- **Each process keeps its own Spans.** That gives no single place to look and no Turn-wide
  Trace.

## Consequences

Trace context becomes part of the wire contract (`packages/protocol`). It does not change how
commands are decided or acknowledged, but the change must say so against `packages/spec`. The extra metadata must cost nothing measurable when Developer Mode is off
(the `idle` and `sessions` bench scenarios).
