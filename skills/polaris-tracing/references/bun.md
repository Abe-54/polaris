# Bun: a manual SDK

Bun ignores `NODE_OPTIONS`, and Node's auto-instrumentations don't reach `Bun.serve`, `bun:sqlite` or `Bun.sql`. Register the SDK by hand and wrap the server's handler yourself; the spans inside come from [tracing-helper.md](tracing-helper.md).

## Install

```sh
bun add @opentelemetry/api@^1.10 @opentelemetry/sdk-trace@^3 @opentelemetry/sdk-logs@^3 @opentelemetry/resources@^3 \
  @opentelemetry/context-async-hooks@^3 @opentelemetry/core@^3 \
  @opentelemetry/exporter-trace-otlp-proto@^0.300 @opentelemetry/exporter-logs-otlp-proto@^0.300
```

## `instrumentation.ts`

```ts
const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export let shutdownTelemetry = async () => {};

if (endpoint) {
  const { context, logs, propagation, trace } = await import("@opentelemetry/api");
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
  const { W3CTraceContextPropagator } = await import("@opentelemetry/core");
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-proto");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { BatchLogRecordProcessor, LoggerProvider } = await import("@opentelemetry/sdk-logs");
  const { BatchSpanProcessor, TracerProvider } = await import("@opentelemetry/sdk-trace");

  const resource = resourceFromAttributes({ "service.name": "rates-api" }); // the package name

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
  });

  const loggerProvider = new LoggerProvider({
    resource,
    processors: (process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
      ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]
      : [],
  });

  // Without a context manager, a span started inside a handler has no parent.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);

  shutdownTelemetry = async () => {
    try {
      await tracerProvider.shutdown();
    } finally {
      await loggerProvider.shutdown();
    }
  };
}
```

Load it only in the dev script: `bun --preload ./instrumentation.ts src/server.ts`. Leave production's command unchanged, even when production has its own collector endpoint. Do not put this preload at the top level of `bunfig.toml`.

For tests, use `bun test --preload ./instrumentation.ts`, or a dedicated dev/test config with `[test] preload = ["./instrumentation.ts"]`. A top-level bunfig preload does not apply to `bun test`.

Import `shutdownTelemetry` and await it after draining the server/jobs in the app's existing shutdown handler, before its existing exit. Keep the app's exit code and signal behavior. The preload registers no signal handlers. If no app handler exists, add it in the entry point: drain the server/workers, await telemetry, then preserve the signal exit status (SIGTERM 143, SIGINT 130). For short-lived scripts/tests, await it in `finally`. Providers shut down sequentially so their last batches do not race on older receivers. Leave compression unset; Polaris accepts traces and logs, not metrics.

## A server span per request

Save this as **`src/http.ts`**, beside `src/tracing.ts`. Wrap the server's `fetch` handler (and each handler in `routes`, with its route pattern):

```ts
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { recordFailure } from "./tracing.ts";

const server = trace.getTracer("http");

/** One SERVER span per request, named by its route pattern, continuing an incoming traceparent. */
export const tracedFetch =
  (route: (req: Request) => string, handler: (req: Request) => Response | Promise<Response>) =>
  (req: Request) => {
    const parent = propagation.extract(context.active(), Object.fromEntries(req.headers));
    const pattern = route(req);

    return server.startActiveSpan(
      `${req.method} ${pattern}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": req.method,
          "http.route": pattern,
          "url.path": new URL(req.url).pathname,
        },
      },
      parent,
      async (span) => {
        try {
          const res = await handler(req);
          span.setAttribute("http.response.status_code", res.status);
          if (res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          return res;
        } catch (error) {
          recordFailure(span, error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  };
```

```ts
Bun.serve({
  port: 3000,
  fetch: tracedFetch(
    (req) => (new URL(req.url).pathname.startsWith("/rates/") ? "/rates/:currency" : "unmatched"),
    handle
  ),
});
```

The route function returns the pattern, never the raw path with ids in it. Wrap database queries with `traced` from the helper. For outgoing HTTP, use `outgoingFetch` below so the service map gets a CLIENT span and the remote service receives its parent context. Nothing patches them on Bun.


## Outgoing HTTP

Add this to **`src/http.ts`**, reusing its imports and `server` tracer:

```ts
export const outgoingFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = new URL(req.url);

  return server.startActiveSpan(
    `${req.method} ${url.hostname}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": req.method,
        "server.address": url.hostname,
        "server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      },
    },
    async (span) => {
      try {
        const headers = Object.fromEntries(req.headers);
        propagation.inject(context.active(), headers);
        const res = await fetch(new Request(req, { headers }));
        span.setAttribute("http.response.status_code", res.status);
        if (res.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
        return res;
      } catch (error) {
        recordFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
};
```

Call `await outgoingFetch(url)` from inside the request span. This span measures receipt of response headers; separately wrap response-body processing if that work matters.
