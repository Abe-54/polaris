# Projects that already export

The aim is one exporter per process, aimed at the standard variables with the project's own destination as the fallback. With forwarding enabled, Polaris forwards to its privately resolved collector (launch environment, checkout files, workspace setting or supported vendor suggestion). Verify that target in Traces settings; a fixed URL in app code alone does not configure forwarding. Delivery is best effort and bounded; collector outages can drop upstream batches while local tracing continues.

## Axiom, Honeycomb and other fixed URLs

The usual Axiom setup is an `OTLPTraceExporter` with `url: "https://api.axiom.co/v1/traces"` and `Authorization` / `X-Axiom-Dataset` headers. Apply the fixed-exporter line from SKILL.md to that `url` and keep the headers. Leave the provider, processors and service name as they are.

`@axiomhq/js`, `next-axiom` and `@axiomhq/logging` send logs through Axiom's own ingest API, not OTLP; leave them alone and add an OTLP log exporter only if the project has none. Gate that addition on development **and** a standard logs/general endpoint; otherwise the default exporter posts to localhost:4318 even outside Polaris. Keep any existing production log exporter unchanged.

## `@vercel/otel`

`registerOTel` already reads `OTEL_EXPORTER_OTLP_ENDPOINT` and, in the pinned 2.x versions, adds an exporter for it **beside** any explicit `traceExporter`. Under Polaris the app therefore sends one copy to its vendor and one to Polaris, and Polaris suppresses trace forwarding when it recognizes the separate vendor exporter with automatic processors. Dynamic/spread configurations may not be recognized: inspect Traces settings and disable forwarding if the app already sends that signal to the same collector.

- Change nothing about its exporters: no Polaris exporter, no fixed-exporter line on its `traceExporter` (that would point both copies at Polaris and starve the vendor).
- Keep `spanProcessors` unset or `["auto", …]`; a custom list without `"auto"` drops the environment exporter.
- Set `serviceName` in `registerOTel` if it's missing.
- `@vercel/otel` 2 needs the OpenTelemetry JS 2.x line (`@opentelemetry/api` below 1.10, `sdk-logs` 0.2xx, `resources` 2.x). Install `0.2xx` exporters next to it, and in the tracing helper import `logs` from `@opentelemetry/api-logs`.
- Logs: `registerOTel` takes `logRecordProcessors`; add `new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })` (sdk-logs 0.223) only when the project exports no logs yet, `NODE_ENV !== "production"`, and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? OTEL_EXPORTER_OTLP_ENDPOINT` is set. Put imports and construction inside the gate. For older sdk-logs versions, check the installed constructor declaration: some take the exporter positionally. For a new Next.js setup, copy [next.md](next.md).

## An SDK configured from the environment

`NodeSDK` without a `traceExporter`, the `@opentelemetry/auto-instrumentations-node/register` preload, or exporters constructed without a `url` already follow the standard variables. Add only what's missing: `service.name`, spans from the helper, a dev-gated log exporter. Set `OTEL_METRICS_EXPORTER=none` in the dev command (or `metricReaders: []` in code); Polaris serves no `/v1/metrics`. Keep compression unset/none: gzip receives HTTP 415.

## A local collector on 4318

A project that ships to its own collector (`http://localhost:4318`) by default works through the fixed-exporter line too; outside Polaris it still reaches the collector.
