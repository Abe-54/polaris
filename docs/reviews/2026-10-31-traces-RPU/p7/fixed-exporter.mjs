// FORM=skill uses SKILL.md's fixed-exporter line; FORM=desktop uses the Desktop's FIXED_EXPORTER_CHANGE.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { TracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace";

const existingVendorUrl = process.env.VENDOR_URL; // stands in for "https://api.axiom.co/v1/traces"
const existingHeaders = { authorization: "Bearer xaat-review-not-a-real-token", "x-axiom-dataset": "dev" };

const url =
  process.env.FORM === "desktop"
    ? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? existingVendorUrl
    : process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
        : existingVendorUrl);

const provider = new TracerProvider({
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url, headers: existingHeaders }) })],
});
provider.getTracer("t").startSpan(`fixed-${process.env.FORM}`).end();
await provider.shutdown();
console.log(`${process.env.FORM}: exported to ${url}`);
