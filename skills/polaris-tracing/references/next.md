# Next.js: framework instrumentation

Take this branch before writing a Node preload. Next.js loads `instrumentation.ts` itself, at the project root or in `src/` beside `app/` or `pages/`. It expects an exported `register()` function, and can load it in Node and edge runtimes. Do not add `node --import` to `next dev`.

For a project with no telemetry, install the 2.x-compatible packages with its package manager:

```sh
npm install @vercel/otel@^2.2 @opentelemetry/api@~1.9.0 @opentelemetry/api-logs@^0.223 \
  @opentelemetry/sdk-logs@^0.223 @opentelemetry/exporter-logs-otlp-proto@^0.223
```

Keep the project's existing compatible 2.x peers (`resources`, `sdk-trace-base`, `sdk-metrics` 2.x and `instrumentation` 0.2xx); don't mix the 3.x recipe into this branch. Use `api-logs` for `logs` and `SeverityNumber` in [tracing-helper.md](tracing-helper.md).

## `instrumentation.ts`

For a new setup, this recipe activates only in development with a collector endpoint. Run `next dev` from Polaris; production keeps its existing telemetry/startup.

```ts
export async function register() {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (process.env.NODE_ENV === "production" || !endpoint) return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerOTel } = await import("@vercel/otel");
  const { BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-proto");

  registerOTel({
    serviceName: "web", // the package name
    logRecordProcessors: (process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
      ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]
      : [],
    metricReaders: [],
  });
}
```

`registerOTel` supplies the trace exporter and context propagation; Next supplies request and fetch spans. Keep its automatic span processors. The Node-only log exporter stays inside the runtime check so it does not enter the edge bundle. This recipe instruments Node routes; edge routes need a separate compatible exporter.

For an **existing** `registerOTel`, keep its registration and exporters in place; apply [existing-exporters.md](existing-exporters.md), including its log gate. Do not replace production's registration with this dev-only recipe.

Exercise a real route with a child span, a failure and a correlated log. Wait about 6 seconds before checking `traces`. Next owns the server lifecycle; don't install another signal handler. Let normal framework shutdown finish. For an isolated script exercising `register()`, allow batch export to complete before exiting; use the SDK's explicit shutdown API when the application owns that SDK.

Convention: [Next.js instrumentation](https://nextjs.org/docs/app/guides/instrumentation).

Next dev bundlers can report virtual `webpack-internal://` paths and generated line numbers. For these handlers, pass explicit `code.file.path` (the absolute source path) and `code.line.number` in `traced`'s attributes; check the link against the source before calling setup complete. Node ESM/CommonJS and Bun unbundled stacks use the helper directly.
