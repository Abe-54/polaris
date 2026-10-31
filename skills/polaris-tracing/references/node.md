# Node: a new SDK setup

For a Node project with no telemetry. The SDK starts only when an OTLP endpoint is set, so the app runs exactly as before anywhere Polaris (or a collector) isn't present.

## Install

Use the project's package manager:

```sh
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
  @opentelemetry/instrumentation @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/exporter-logs-otlp-proto @opentelemetry/sdk-logs
```

This is the OpenTelemetry JS 3.x line (`@opentelemetry/api` 1.10+, `sdk-node` 0.300+, `sdk-logs` 3+). If the project already depends on 2.x packages (`sdk-node` 0.2xx, `sdk-logs` 0.2xx, or `@vercel/otel` 2), stay on 2.x: install the `0.2xx` exporters and pass the exporter itself to the processor (`new BatchLogRecordProcessor(exporter)`) where 3.x takes `{ exporter }`.

## `instrumentation.ts`

At the project root (`.mjs` if the project has no TypeScript runner):

```ts
import { register } from "node:module";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  // ESM imports (including node:http) are only patched through this loader hook.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const sdk = new NodeSDK({
    serviceName: "orders-api", // the package name
    traceExporter: new OTLPTraceExporter(),
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    metricReaders: [], // otherwise NodeSDK also exports metrics, which Polaris doesn't receive
    instrumentations: [
      getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } }),
    ],
  });

  sdk.start();

  const stop = () => sdk.shutdown().finally(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
```

- The exporters take no `url`: they read `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, else `OTEL_EXPORTER_OTLP_ENDPOINT` plus `/v1/traces` and `/v1/logs`.
- Keep `metricReaders: []` unless the project exports metrics somewhere already.
- The `fs` instrumentation is off because it makes a span per file call and buries the request spans.
- `shutdown` flushes what's batched; a short-lived script (a test run, a CLI) must `await sdk.shutdown()` before it exits, or its last spans are lost.

## Load it first

The SDK has to start before the app imports `http`, `express` or a database driver. Change the start command (the `dev` script, not the deploy one unless the user asks):

| Project | Command |
|---|---|
| ESM or TypeScript on Node 22.18+ | `node --import ./instrumentation.ts src/server.ts` |
| CommonJS | `node --require ./instrumentation.js src/server.js` (write the file with `require`, and drop the `register` call) |
| `tsx` | `tsx --import ./instrumentation.ts src/server.ts` |
| Next.js | use `@vercel/otel` in `instrumentation.ts`; see [existing-exporters.md](existing-exporters.md) |

Then add spans and logs with [tracing-helper.md](tracing-helper.md).
