---
status: accepted
---

# Requests send from the Daemon, from `.http` files, gated like Data

## Context

Requests is a small HTTP client whose reason to exist is its link to Traces and Data; anything
more is Postman's job. Four choices shape it and are expensive to change later.

## Decision

- **The Daemon sends.** A Send goes out from the checkout's Host, as Data's Queries do, so
  `localhost` means the Host (as a Host address does in the Browser) and agents and the Desktop
  App share one path.
- **`.http` files are the format.** They are the VS Code REST Client and JetBrains format: plain
  text, diffable, editable in the Editor and easy for agents to write. Postman collections are
  import-only (a follow-up): their scripts, auth helpers and variable scopes can't round-trip
  without rebuilding Postman.
- **Agent Sends are gated like Data Sources.** Local Origins need nothing; a Remote Origin needs
  an Origin Approval, with writes allowed separately. A loopback listener owned by a tunnel is
  Remote, reusing Data's listener-owner check, because tunnels put production on `localhost`.
  Requiring a checkout-owned listener (Data's strictest rule) was rejected: it would prompt for
  every Docker-published port. User Sends are never gated. Secrets resolved from variables never
  reach the agent.
- **Polaris records each Send's root client Span** and injects `traceparent` unless the Request
  sets its own. The Trace then exists even when the app is uninstrumented, and Spans arriving on
  other tokens in the same checkout join it by trace id.

## Consequences

The Data link is table-level: database Spans keep SQL text but rarely bound values, so exact rows
can't be recovered in general. Row-level links are a follow-up.
