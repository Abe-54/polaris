# Projects that already export

The aim is one exporter per process, aimed at the standard variables with the project's own destination as the fallback. Polaris forwards what it receives to that destination, so the vendor keeps getting every span once.

## Axiom, Honeycomb and other fixed URLs

The usual Axiom setup is an `OTLPTraceExporter` with `url: "https://api.axiom.co/v1/traces"` and `Authorization` / `X-Axiom-Dataset` headers. Apply the fixed-exporter line from SKILL.md to that `url` and keep the headers. Leave the provider, processors and service name as they are.

`@axiomhq/js`, `next-axiom` and `@axiomhq/logging` send logs through Axiom's own ingest API, not OTLP; leave them alone and add an OTLP log exporter only if the project has none.

## `@vercel/otel`

`registerOTel` already reads `OTEL_EXPORTER_OTLP_ENDPOINT` and, in the pinned 2.x versions, adds an exporter for it **beside** any explicit `traceExporter`. Under Polaris the app therefore sends one copy to its vendor and one to Polaris, and Polaris doesn't forward that copy again.

- Change nothing about its exporters: no Polaris exporter, no fixed-exporter line on its `traceExporter` (that would point both copies at Polaris and starve the vendor).
- Keep `spanProcessors` unset or `["auto", …]`; a custom list without `"auto"` drops the environment exporter.
- Set `serviceName` in `registerOTel` if it's missing.
- `@vercel/otel` 2 needs the OpenTelemetry JS 2.x line (`@opentelemetry/api` below 1.10, `sdk-logs` 0.2xx, `resources` 2.x). Install `0.2xx` exporters next to it, and in the tracing helper import `logs` from `@opentelemetry/api-logs`.
- Logs: `registerOTel` takes `logRecordProcessors`; add `new BatchLogRecordProcessor(new OTLPLogExporter())` (2.x form) only if the project exports no logs yet.

## An SDK configured from the environment

`NodeSDK` without a `traceExporter`, the `@opentelemetry/auto-instrumentations-node/register` preload, or exporters constructed without a `url` already follow the standard variables. Add only what's missing: `service.name`, spans from the helper, a log exporter.

## A local collector on 4318

A project that ships to its own collector (`http://localhost:4318`) by default works through the fixed-exporter line too; outside Polaris it still reaches the collector.
