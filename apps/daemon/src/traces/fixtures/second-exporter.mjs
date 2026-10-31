import { registerOTel } from "@vercel/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { trace } from "@opentelemetry/api";

registerOTel({
  serviceName: "second-exporter-test",
  instrumentations: [],
  traceExporter: new OTLPTraceExporter({ url: process.env.TEST_VENDOR_URL }),
});

const span = trace.getTracer("second-exporter").startSpan("vendor-once");

span.end();

const provider = trace.getTracerProvider().getDelegate();

await provider.forceFlush();

await provider.shutdown();

console.log(JSON.stringify({ traceId: span.spanContext().traceId }));
