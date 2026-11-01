---
name: polaris-tracing
description: Add OpenTelemetry traces and logs to a Node or Bun project so Polaris shows them, keeping an existing Axiom, @vercel/otel or other exporter working. Use when asked to set up tracing, instrument an app, send spans or logs to Polaris, or when the `traces` tool reports E-TRACE-NONE.
---

# Polaris tracing

Polaris runs an OTLP/HTTP receiver beside your agent session. Commands Polaris launches get its address in `OTEL_EXPORTER_OTLP_ENDPOINT`: a base URL such as `http://127.0.0.1:4319/otlp/<token>`, with no trailing slash, to which the OTLP paths `/v1/traces` and `/v1/logs` are appended. The token belongs to this session: code reads the variable, and the literal URL never goes in a file.

The app's job is to export OTLP over HTTP (protobuf or JSON) to whatever the standard variables name. Change dev/test startup only; keep production's startup and telemetry in place. Polaris replaces inherited standard collector endpoints with its local endpoint and keeps those targets privately for forwarding. With forwarding enabled, it sends received OTLP to a collector resolved from the launch environment, checkout `.env*`, workspace settings or a supported vendor suggestion. A literal URL hidden in app code is not automatically a forwarding target: verify the collector in Traces settings and set its full traces URL if needed. Forwarding is a bounded, best-effort queue, not a guarantee that every span arrives upstream.

## Steps

1. **Survey.** Read `package.json` and the lockfile, and find the existing telemetry: grep for `@opentelemetry/`, `@vercel/otel`, `registerOTel`, `@axiomhq`, `OTLPTraceExporter`, `instrumentation.ts`, `api.axiom.co`, `/v1/traces`. Note the runtime (Node or Bun), the module format, the command that starts the dev server, and the installed OpenTelemetry JS line: 3.x (`@opentelemetry/api` 1.10+) or 2.x. Done when you can name the branch below, the file that starts the app, and the version line.

2. **Take the branch.**
   - **Next.js:** [references/next.md](references/next.md), including projects with no telemetry.
   - **No telemetry, Node:** [references/node.md](references/node.md).
   - **No telemetry, Bun (`Bun.serve`, `bun run`):** [references/bun.md](references/bun.md). Nothing instruments Bun automatically; its spans come from a manual SDK and your wrappers.
   - **An exporter with a literal URL** (Axiom, Honeycomb, a collector on 4318): apply the fixed-exporter line below, then continue through steps 3–7 and [references/existing-exporters.md](references/existing-exporters.md).
   - **`@vercel/otel`:** leave its exporters alone; read [references/existing-exporters.md](references/existing-exporters.md) first.
   - **An SDK already configured from the standard variables:** go to step 3.

   Stay on the version line the project already uses; the logs API global differs, and processor constructor signatures also vary within the 2.x line. Check the installed declarations; mixing globals silently drops logs. Done when one SDK, registered once and before the app's imports, exports to the standard variables.

3. **Name the service.** Set `service.name` to the package name (`serviceName` in `NodeSDK` and `registerOTel`, the `service.name` resource attribute otherwise). Keep a name the project already sets. Polaris groups and labels traces by it. Done when each process you instrumented has a distinct, stable name.

4. **Add the spans an agent needs.** Copy the helper in [references/tracing-helper.md](references/tracing-helper.md) and wrap the project's own entry points and slow paths in `await traced(name, fn)`: handlers, jobs, queries the instrumentations miss. Each span it makes carries `code.function.name`, `code.file.path` and `code.line.number`, so Polaris links it to its source; on failure it calls `span.recordException(error)` and sets ERROR status with the message, then rethrows, so Polaris shows the exception's type, message and stack. Done when a request through the app's main path produces a server span with child spans for its work.

5. **Export logs.** Both references add an OTLP log exporter beside the trace exporter. Log inside the active span (the helper's `log`, or the project's pino/winston logger on Node) so each record carries its trace and span ids. Done when a log line written during a request sits under that request's span.

6. **Run it.** Restart the dev server or rerun the command from this agent session so it inherits `OTEL_EXPORTER_OTLP_ENDPOINT`; a process started before the change, or from a terminal outside Polaris, keeps its old environment. Exercise what you instrumented: `curl` the route, run the test, including one request that fails.

7. **Check that spans arrive.** Call the Polaris `traces` tool, then `trace { id }` on the newest trace and `span { trace, span }` on a span you wrote. Done when:
   - the trace is listed with the right service name, and its root is the server span;
   - a span you wrote shows its `code.file.path:code.line.number`;
   - the failing request shows ERROR with its exception, and a log record sits under its span.

   `traces` lists the current turn by default. Spans are attributed by when they start, not merely when the server launched. For either `E-TRACE-NONE` or “0 traces”:
   - Wait about 6 seconds after the request: the default batch delay is about 5 seconds. A short-lived script/test must await shutdown instead.
   - Inspect endpoint **shape** in the shell that launches the app without printing its private token: `node -e 'for (const k of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]) { const v = process.env[k]; console.log(k, !v ? "unset" : /^http:\/\/127\.0\.0\.1:4319\/otlp\/[^/]+(?:\/v1\/traces)?$/.test(v) ? "Polaris endpoint" : "external endpoint"); }'`.
   - An unset endpoint means injection did not reach this process (for example, it started outside Polaris, before setup, or through a tool that filtered its environment). Restart it from this agent session. An external endpoint means this process is sending elsewhere; current Polaris captures inherited endpoints for forwarding, but older Daemons skipped injection when a user endpoint was set.
   - The general variable is a **base** `/otlp/<token>`; a signal-specific traces URL ends in `/otlp/<token>/v1/traces`. Don't append that suffix twice. Use the exporter's HTTP/protobuf or HTTP/JSON variant, without gzip. Polaris has no metrics receiver: on environment-configured SDKs set `OTEL_METRICS_EXPORTER=none` for the dev command.
   - Check Traces settings: local tracing must be enabled; forwarding is an independent switch and does not make spans appear locally.
   - Retry `traces` with `turn: "all"`. A process launched outside this session may have null or other-session turn attribution. Check checkout/service filters and restart from this session if necessary.
   - Await telemetry shutdown **inside the app's existing drain handler** before it exits; keep its exit status. Don't add a competing SIGTERM handler. See the runtime reference.

## The fixed-exporter line

An exporter constructed with a literal `url` ignores the environment. Make it read the standard variables first, with the project's URL as the fallback:

```ts
const url =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
    : existingVendorUrl); // the project's existing URL

new OTLPTraceExporter({ url, headers: existingHeaders });
```

Keep the existing headers (an Axiom token, a dataset). When forwarding, Polaris sends raw OTLP bytes and request headers upstream; credentials stay in memory and are not persisted in trace storage or settings. Confirm the upstream target separately: this fallback URL is not visible to the Daemon just because it is in this expression. Do the same for a log exporter with `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and `/v1/logs`. Then check whether the deployed environment sets `OTEL_EXPORTER_OTLP_ENDPOINT` for another purpose; if it does, tell the user, since this line now honours it there too.

Keep one exporter per signal. For `@vercel/otel` with an existing separate vendor exporter, follow its reference: Polaris suppresses duplicate forwarding only when it can recognize that configuration. Confirm dynamic configurations in Traces settings.

## Installing this skill

Use the skill shipped with the matching Polaris release. For this source checkout, install the reviewed local copy globally so the project gains no files:

```sh
npx skills add ./skills/polaris-tracing -a claude-code codex -y -g
```

To install it into one project instead, committed with the repository for everyone who works on it, run `npx skills add /absolute/path/to/polaris/skills/polaris-tracing -a claude-code codex -y` from the project's root, using the reviewed checkout's absolute path.

Run that command from the Polaris source root. For a remote install, use a reviewed release tag or commit containing this skill (`https://github.com/luxdotdev/polaris/tree/<reviewed-ref> --skill polaris-tracing`), not an unpinned main branch. Verify the ref contains `skills/polaris-tracing/SKILL.md` before installing; a source-only ref is not a published release.
