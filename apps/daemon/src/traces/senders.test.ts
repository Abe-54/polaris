import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { withTraceFixture } from "./testing.ts";

const SenderResult = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  spans: Schema.Number,
});

const runSender = async (mode: "manual" | "vercel", endpoint: string) => {
  const env = { ...process.env };

  for (const key of Object.keys(env)) if (key.startsWith("OTEL_")) delete env[key];

  const child = Bun.spawn(
    ["node", fileURLToPath(new URL("./fixtures/sender.mjs", import.meta.url)), mode],
    {
      env: {
        ...env,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: mode === "vercel" ? "http/json" : "http/protobuf",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    }
  );

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exit, stderr).toBe(0);

  return Schema.decodeUnknownSync(Schema.fromJsonString(SenderResult))(stdout.trim());
};

test(
  "real manual protobuf and env-configured @vercel/otel JSON reach receiver, SQLite and query API",
  () =>
    withTraceFixture(async (f) => {
      const manual = await runSender("manual", f.endpoint!);
      const vercel = await runSender("vercel", f.endpoint!);
      const page = await Effect.runPromise(f.store.list(f.root));
      expect(page.total).toBe(2);
      const first = await Effect.runPromise(f.store.get(f.root, manual.traceId));
      expect(first.spans).toHaveLength(1000);
      expect(first.summary.errors).toBe(1);
      expect(first.summary.services).toEqual(["manual-sender"]);
      expect(first.spans.filter((span) => span.parentId === manual.spanId)).toHaveLength(999);
      expect(first.spans.find((span) => span.parentId !== null)?.links[0]?.spanId).toBe(
        manual.spanId
      );
      expect(JSON.stringify(first)).not.toContain("private-");
      expect(JSON.stringify(first)).not.toContain("resource-secret");
      const second = await Effect.runPromise(f.store.span(f.root, vercel.traceId, vercel.spanId));
      expect(second.span.name).toBe("GET /hello");
      expect(second.span.service).toBe("vercel-sender");
      expect(second.span.attributes.apiKey).toBe("[redacted]");
    }),
  30_000
);
