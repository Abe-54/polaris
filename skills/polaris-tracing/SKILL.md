---
name: polaris-tracing
description: Add OpenTelemetry traces and logs to a Node or Bun project so Polaris shows them, keeping an existing Axiom, @vercel/otel or other exporter working. Use when asked to set up tracing, instrument an app, send spans or logs to Polaris, or when the `traces` tool reports E-TRACE-NONE.
---

# Polaris tracing

Polaris runs an OTLP/HTTP receiver beside your agent session. Commands Polaris launches get its address in `OTEL_EXPORTER_OTLP_ENDPOINT`: a base URL such as `http://127.0.0.1:4319/otlp/<token>`, with no trailing slash, to which the OTLP paths `/v1/traces` and `/v1/logs` are appended. The token belongs to this session: code reads the variable, and the literal URL never goes in a file.

The app's job is to export OTLP over HTTP (protobuf or JSON) to whatever the standard variables name. Outside Polaris they are unset, or point at the user's own collector, so production keeps behaving as it does today. Polaris forwards what it receives to the app's own collector, so one exporter per process is enough.

## Steps

1. **Survey.** Read `package.json` and the lockfile, and find the existing telemetry: grep for `@opentelemetry/`, `@vercel/otel`, `registerOTel`, `@axiomhq`, `OTLPTraceExporter`, `instrumentation.ts`, `api.axiom.co`, `/v1/traces`. Note the runtime (Node or Bun), the module format, the command that starts the dev server, and the installed OpenTelemetry JS line: 3.x (`@opentelemetry/api` 1.10+) or 2.x. Done when you can name the branch below, the file that starts the app, and the version line.

2. **Take the branch.**
   - **No telemetry, Node:** [references/node.md](references/node.md).
   - **No telemetry, Bun (`Bun.serve`, `bun run`):** [references/bun.md](references/bun.md). Nothing instruments Bun automatically; its spans come from a manual SDK and your wrappers.
   - **An exporter with a literal URL** (Axiom, Honeycomb, a collector on 4318): the fixed-exporter line below, nothing else.
   - **`@vercel/otel`:** leave its exporters alone; read [references/existing-exporters.md](references/existing-exporters.md) first.
   - **An SDK already configured from the standard variables:** go to step 3.

   Stay on the version line the project already uses; the two lines differ in constructors and in where the logs API lives, and mixing them fails silently. Done when one SDK, registered once and before the app's imports, exports to the standard variables.

3. **Name the service.** Set `service.name` to the package name (`serviceName` in `NodeSDK` and `registerOTel`, the `service.name` resource attribute otherwise). Keep a name the project already sets. Polaris groups and labels traces by it. Done when each process you instrumented has a distinct, stable name.

4. **Add the spans an agent needs.** Copy the helper in [references/tracing-helper.md](references/tracing-helper.md) and wrap the project's own entry points and slow paths in `await traced(name, fn)`: handlers, jobs, queries the instrumentations miss. Each span it makes carries `code.function.name`, `code.file.path` and `code.line.number`, so Polaris links it to its source; on failure it calls `span.recordException(error)` and sets ERROR status with the message, then rethrows, so Polaris shows the exception's type, message and stack. Done when a request through the app's main path produces a server span with child spans for its work.

5. **Export logs.** Both references add an OTLP log exporter beside the trace exporter. Log inside the active span (the helper's `log`, or the project's pino/winston logger on Node) so each record carries its trace and span ids. Done when a log line written during a request sits under that request's span.

6. **Run it.** Restart the dev server or rerun the command from this agent session so it inherits `OTEL_EXPORTER_OTLP_ENDPOINT`; a process started before the change, or from a terminal outside Polaris, keeps its old environment. Exercise what you instrumented: `curl` the route, run the test, including one request that fails.

7. **Check that spans arrive.** Call the Polaris `traces` tool, then `trace { id }` on the newest trace and `span { trace, span }` on a span you wrote. Done when:
   - the trace is listed with the right service name, and its root is the server span;
   - a span you wrote shows its `code.file.path:code.line.number`;
   - the failing request shows ERROR with its exception, and a log record sits under its span.

   `traces` lists the current Turn by default; spans from a process started in an earlier Turn need `turn: "all"`. If it returns `E-TRACE-NONE`, nothing reached the receiver:
   - `echo "$OTEL_EXPORTER_OTLP_ENDPOINT"` in the shell that starts the app. Empty means the process wasn't launched by Polaris, or the user exported their own endpoint and their collector gets the spans.
   - A URL whose path isn't `/otlp/<token>/v1/traces` means the code built it wrong.
   - A short-lived process (a script, a test run) loses batched spans unless it awaits the SDK's `shutdown()` before exiting.

## The fixed-exporter line

An exporter constructed with a literal `url` ignores the environment. Make it read the standard variables first, with the project's URL as the fallback:

```ts
const url =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
    : "https://api.axiom.co/v1/traces"); // the project's existing URL

new OTLPTraceExporter({ url, headers: existingHeaders });
```

Keep the existing headers (an Axiom token, a dataset): Polaris passes them on when it forwards and never stores them. Do the same for a log exporter with `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and `/v1/logs`. Then check whether the deployed environment sets `OTEL_EXPORTER_OTLP_ENDPOINT` for another purpose; if it does, tell the user, since this line now honours it there too.

The original exporter stays the only one: a second exporter aimed at Polaris would send every span twice once Polaris forwards.

## Installing this skill

Polaris installs it globally for the user, so the repository gains no files:

```sh
npx skills add luxdotdev/polaris --skill polaris-tracing -a claude-code codex -y -g
```

To install it into one project instead, committed with the repository for everyone who works on it, run the same command from the project's root without `-g`.
