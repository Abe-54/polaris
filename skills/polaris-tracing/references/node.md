# Node: a new SDK setup

For a Node project with no telemetry. For **Next.js**, use [next.md](next.md) instead: Next owns `instrumentation.ts` and calls its `register()` export.

Only change the dev command. The gate below avoids loading SDK packages when no endpoint is set. A production deployment that sets its own endpoint keeps its existing startup command.

## Install

Use the project's package manager:

```sh
npm install @opentelemetry/api@^1.10 @opentelemetry/sdk-node@^0.300 \
  @opentelemetry/auto-instrumentations-node@^0.82 @opentelemetry/instrumentation@^0.300 \
  @opentelemetry/sdk-trace@^3 @opentelemetry/exporter-trace-otlp-proto@^0.300 \
  @opentelemetry/exporter-logs-otlp-proto@^0.300 @opentelemetry/sdk-logs@^3
```

This is the OpenTelemetry JS 3.x line. If the project already uses 2.x (`sdk-node` 0.2xx, `sdk-logs` 0.2xx, or `@vercel/otel` 2), stay on that line: use its installed exporters, processor constructors from its installed declarations, and import logs from `@opentelemetry/api-logs` in the helper. Do not upgrade unrelated telemetry.

## ESM: `instrumentation.ts`

At the project root (`.mjs` also works; this snippet contains no TypeScript-only syntax):

```ts
const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export let shutdownTelemetry = async () => {};

if (endpoint) {
  const { register } = await import("node:module");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-proto");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  const { BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
  const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace");
  const { NodeSDK } = await import("@opentelemetry/sdk-node");

  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const spans = new BatchSpanProcessor({ exporter: new OTLPTraceExporter() });
  const logs = (process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
    ? new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })
    : undefined;
  const sdk = new NodeSDK({
    serviceName: "orders-api", // the package name
    spanProcessors: [spans],
    logRecordProcessors: logs ? [logs] : [],
    metricReaders: [],
    instrumentations: [
      getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } }),
    ],
  });
  sdk.start();

  shutdownTelemetry = async () => {
    try {
      await spans.forceFlush();
      await logs?.forceFlush();
    } finally {
      await sdk.shutdown();
    }
  };
}
```

## CommonJS: `instrumentation.cjs`

Use this synchronous preload, so startup finishes before the app's first `require("node:http")`. Do not wrap it in an unawaited async function.

```js
const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

module.exports.shutdownTelemetry = async () => {};

if (endpoint) {
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-proto");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
  const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
  const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace");
  const { NodeSDK } = require("@opentelemetry/sdk-node");

  const spans = new BatchSpanProcessor({ exporter: new OTLPTraceExporter() });
  const logs = (process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
    ? new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })
    : undefined;
  const sdk = new NodeSDK({
    serviceName: "orders-api",
    spanProcessors: [spans],
    logRecordProcessors: logs ? [logs] : [],
    metricReaders: [],
    instrumentations: [
      getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } }),
    ],
  });
  sdk.start();

  module.exports.shutdownTelemetry = async () => {
    try {
      await spans.forceFlush();
      await logs?.forceFlush();
    } finally {
      await sdk.shutdown();
    }
  };
}
```

## Load and stop

The SDK starts before the app imports `http`, `express` or a database driver. Change the **dev** script:

| Project | Command |
|---|---|
| ESM TypeScript on Node 24 | `node --import ./instrumentation.ts src/server.ts` |
| ESM JavaScript | `node --import ./instrumentation.mjs src/server.mjs` |
| CommonJS | `node --require ./instrumentation.cjs src/server.cjs` |
| `tsx` | `tsx --import ./instrumentation.ts src/server.ts` |

The exporters read signal-specific URLs verbatim, else the base endpoint plus `/v1/traces` or `/v1/logs`. Leave compression unset (`none`): Polaris refuses compressed requests. Keep `metricReaders: []`; Polaris has no metrics receiver. The ESM loader hook patches ESM imports, and fs instrumentation is disabled to avoid a span per file call.

Import `shutdownTelemetry` in the app and **await it after draining requests/jobs in the app's existing shutdown handler**, before any existing `process.exit(...)`. Preserve that handler's signal behavior and exit code. The preload installs no signal handlers. If the app has no shutdown handler, add one in its entry point that closes its server/workers, awaits telemetry, then preserves the signal exit status (SIGTERM 143, SIGINT 130); do not force success. For a CLI/test, use `try { await main(); } finally { await shutdownTelemetry(); }`. Flush spans then logs to avoid competing for older receivers' single in-flight request slot; allow exporter retries to complete. SIGKILL cannot flush.

Add spans and logs with [tracing-helper.md](tracing-helper.md). For plain `node:http`, automatic spans may be named only `GET`. At route dispatch set `trace.getActiveSpan()?.setAttributes({ "http.route": "/orders/:id" })` and `trace.getActiveSpan()?.updateName("GET /orders/:id")`; use the router's pattern, never the URL's raw ids.
