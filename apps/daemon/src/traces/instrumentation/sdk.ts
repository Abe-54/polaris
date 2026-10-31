import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";

// Explicit URLs keep inherited vendor signal endpoints from bypassing Polaris.
const endpoint = process.env.POLARIS_OTEL_ENDPOINT;

if (endpoint && !process.versions.bun) {
  try {
    // The receiver admits one request per token; logs and traces share a serial connection.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const transport = { headers: {}, timeoutMillis: 1000, httpAgentOptions: () => agent };

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        "service.name": process.env.POLARIS_OTEL_SERVICE_NAME ?? "node-app",
      }),
      autoDetectResources: false,
      metricReaders: [],
      traceExporter: new OTLPTraceExporter({ ...transport, url: `${endpoint}/v1/traces` }),
      logRecordProcessors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ ...transport, url: `${endpoint}/v1/logs` }),
          exportTimeoutMillis: 1000,
        }),
      ],
      instrumentations: [
        new HttpInstrumentation(),
        new UndiciInstrumentation(),
        new PgInstrumentation(),
        new MySQL2Instrumentation(),
        new ExpressInstrumentation(),
      ],
    });

    sdk.start();
    // beforeExit flushes finite commands without taking over the app's signal handlers.
    process.once("beforeExit", () => {
      void sdk.shutdown().catch(() => {});
    });
  } catch {
    // Provider conflicts or an unavailable exporter never crash the application.
  }
}

import { Agent } from "node:http";
