# The tracing helper

One file for Node ESM, compiled CommonJS and Bun: `traced` wraps a unit of work in a span with its `code.*` location and records failures; `log` emits a log record inside the active span. Save it as `src/tracing.ts` (or beside the code that uses it) and import it where you add spans.

```ts
import { logs, SeverityNumber, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { fileURLToPath } from "node:url";

const tracer = trace.getTracer("app");
const logger = logs.getLogger("app");

// A stack frame: "at fn (path:line:col)" or "at path:line:col".
const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?\s*$/;

/** The first frame outside this file: where traced() was called. */
const callerLocation = (fallbackName: string): Attributes => {
  const holder = { stack: "" };
  Error.captureStackTrace(holder, traced);

  for (const text of holder.stack.split("\n").slice(1)) {
    const [, fn, raw = "", line] = FRAME.exec(text) ?? [];
    const path = raw.startsWith("file://") ? fileURLToPath(raw) : raw;

    if (path === "") continue;
    const name = fn?.replace(/^async /, "");

    return {
      "code.function.name": name && name !== "<anonymous>" ? name : fallbackName,
      "code.file.path": path,
      "code.line.number": Number(line),
    };
  }

  return { "code.function.name": fallbackName };
};

export const recordFailure = (span: Span, error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
};

/** Runs `fn` in a span named `name`, located at the caller; failures are recorded and rethrown. */
export function traced<T>(name: string, fn: (span: Span) => Promise<T> | T, attributes: Attributes = {}): Promise<T> {
  const location = callerLocation(name);

  return tracer.startActiveSpan(name, { attributes: { ...location, ...attributes } }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** A log record, correlated with whichever span is active when it's called. */
export function log(message: string, attributes: Attributes = {}, severity: Severity = "INFO") {
  logger.emit({ body: message, severityText: severity, severityNumber: SeverityNumber[severity], attributes });
}
```

For CommonJS, compile this TypeScript file with the app (`module: "commonjs"`), or translate imports/exports to `require`/`module.exports`. It uses no `import.meta`; Node 24 cannot `require` TypeScript containing ESM exports in a `type: "commonjs"` package.

Use it on the project's own code, where the instrumentations can't see:

```ts
const loadOrders = async (customer: string) =>
  await traced("orders.load", async (span) => {
    span.setAttribute("customer.id", customer);
    const rows = await db.query(/* … */);
    log("loaded orders", { customer, count: rows.length });
    return rows;
  });
```

- **Names.** A span name is the operation, low in cardinality (`orders.load`, `GET /orders/:id`); put ids and values in attributes.
- **Location.** `code.file.path` is the absolute path of the line that called `traced` (Polaris shows it relative to the checkout). Write `await traced(…)`, never `return traced(…)` or `=> traced(…)`: Bun drops a tail call's frame, and the span then points at the caller's caller. A wrapper around `traced` in another file reports the wrapper's line; give such a wrapper its own `code.*` attributes.
- **Errors** an app handles and turns into a response (a 404, a validation failure) aren't span errors; record them only when the operation failed.
- **Existing loggers.** With the Node auto-instrumentations, pino, winston and bunyan records already reach the log exporter, with trace ids; keep the project's logger and use `log` only where it logs nothing. `console.log` is not exported.
- **OpenTelemetry JS 2.x.** On the 2.x line (`@opentelemetry/api` below 1.10, which `@vercel/otel` 2 requires), import `logs` and `SeverityNumber` from `@opentelemetry/api-logs` instead. The `@opentelemetry/api-logs` 0.2xx package holds a separate global from `@opentelemetry/api` 1.10: mixing the lines gives a logger that silently drops everything.
