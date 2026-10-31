import { createServer } from "node:http";
import { once } from "node:events";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { registerOTel } from "@vercel/otel";

const mode = process.argv[2];

if (mode === "manual") {
  const exporter = new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT });

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "manual-sender",
      "api.key": "resource-secret",
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxExportBatchSize: 1000,
        maxQueueSize: 2000,
        scheduledDelayMillis: 60000,
      }),
    ],
  });

  const tracer = provider.getTracer("manual-test", "1");

  const root = tracer.startSpan("POST /orders", {
    attributes: { authorization: "private-auth", "http.route": "/orders" },
  });

  const parent = trace.setSpan(context.active(), root);

  for (let index = 0; index < 999; index++) {
    const span = tracer.startSpan(
      "query orders",
      {
        attributes: { "db.system": "postgresql", password: "private-password" },
        links: [{ context: root.spanContext() }],
      },
      parent
    );

    span.addEvent("exception", {
      "exception.message": "password=private-event",
      cookie: "private-cookie",
    });

    if (index === 0) span.setStatus({ code: SpanStatusCode.ERROR, message: "operation failed" });
    span.end();
  }

  root.end();
  await provider.forceFlush();
  await provider.shutdown();
  console.log(
    JSON.stringify({
      traceId: root.spanContext().traceId,
      spanId: root.spanContext().spanId,
      spans: 1000,
    })
  );
} else if (mode === "vercel") {
  registerOTel({ serviceName: "vercel-sender", instrumentations: [] });
  let identity;

  const server = createServer((_request, response) => {
    const span = trace.getTracer("vercel-test").startSpan("GET /hello");
    span.setAttribute("apiKey", "private-vercel");
    identity = span.spanContext();
    response.end("hello");
    span.end();
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/hello`);

    if ((await response.text()) !== "hello") throw new Error("HTTP app failed");
    const provider = trace.getTracerProvider().getDelegate();
    await provider.forceFlush();
    await provider.shutdown();
    console.log(JSON.stringify({ traceId: identity.traceId, spanId: identity.spanId, spans: 1 }));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
} else throw new Error("Unknown sender");
