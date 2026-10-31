# Bun: a manual SDK

Bun ignores `NODE_OPTIONS`, and Node's auto-instrumentations don't reach `Bun.serve`, `bun:sqlite` or `Bun.sql`. Register the SDK by hand and wrap the server's handler yourself; the spans inside come from [tracing-helper.md](tracing-helper.md).

## Install

```sh
bun add @opentelemetry/api @opentelemetry/sdk-trace @opentelemetry/sdk-logs @opentelemetry/resources \
  @opentelemetry/context-async-hooks @opentelemetry/core \
  @opentelemetry/exporter-trace-otlp-proto @opentelemetry/exporter-logs-otlp-proto
```

## `instrumentation.ts`

```ts
import { context, logs, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const resource = resourceFromAttributes({ "service.name": "rates-api" }); // the package name

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
  });

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  });

  // Without a context manager, a span started inside a handler has no parent.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);

  const stop = async () => {
    await Promise.allSettled([tracerProvider.shutdown(), loggerProvider.shutdown()]);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
```

Load it before the app: `bun --preload ./instrumentation.ts src/server.ts` in the `dev` script, or `preload = ["./instrumentation.ts"]` in `bunfig.toml` (which also applies to `bun test`).

## A server span per request

Add this to the tracing helper and wrap `fetch` (and each handler in `routes`, with its route pattern):

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
    (req) => (new URL(req.url).pathname.startsWith("/rates/") ? "/rates/:currency" : new URL(req.url).pathname),
    handle
  ),
});
```

The route function returns the pattern, never the raw path with ids in it. Wrap outgoing `fetch` calls and database queries with `traced` from the helper; nothing patches them on Bun.
