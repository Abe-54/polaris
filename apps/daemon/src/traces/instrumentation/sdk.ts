import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
  getNumberFromEnv,
} from "@opentelemetry/core";
import { TracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";

// Explicit URLs keep inherited vendor signal endpoints from bypassing Polaris.
const endpoint = process.env.POLARIS_OTEL_ENDPOINT;

const guard = Symbol.for("polaris.node-instrumentation.sdk");

if (endpoint && !process.versions.bun && !Reflect.has(globalThis, guard)) {
  Reflect.set(globalThis, guard, true);

  try {
    // The receiver admits one request per token; logs and traces share a serial connection.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const transport = { headers: {}, timeoutMillis: 1000, httpAgentOptions: () => agent };

    const resource = resourceFromAttributes({
      "service.name": process.env.POLARIS_OTEL_SERVICE_NAME ?? "node-app",
    });

    const batchDelay = getNumberFromEnv("OTEL_BSP_SCHEDULE_DELAY") ?? 5000;

    const tracerProvider = new TracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({ ...transport, url: `${endpoint}/v1/traces` }),
          exportTimeoutMillis: 1000,
          scheduledDelayMillis: batchDelay > 0 ? batchDelay : 5000,
        }),
      ],
    });

    const loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ ...transport, url: `${endpoint}/v1/logs` }),
          exportTimeoutMillis: 1000,
        }),
      ],
    });
    // These API setters refuse replacement; an application's existing context and propagation win.

    const contextManager = new AsyncLocalStorageContextManager();

    if (context.setGlobalContextManager(contextManager)) contextManager.enable();
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
      })
    );

    // Trace and log providers stay private; shared context preserves parenting across providers.

    registerInstrumentations({
      tracerProvider,
      loggerProvider,
      instrumentations: [
        new HttpInstrumentation(),
        new UndiciInstrumentation(),
        new PgInstrumentation(),
        new MySQL2Instrumentation(),
        new ExpressInstrumentation(),
      ],
    });

    // beforeExit flushes finite commands without taking over the app's signal handlers.
    process.once("beforeExit", () => {
      void Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]).catch(() => {});
    });
  } catch {
    // Provider conflicts or an unavailable exporter never crash the application.
  }
}

import { Agent } from "node:http";
