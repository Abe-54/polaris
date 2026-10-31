import { expect, test } from "bun:test";
import { decodeBatch } from "./decoder.ts";
import { TEST_SESSION, TEST_WORKSPACE, traceFixture, spanFixture } from "./testing.ts";

// Frozen ExportLogsServiceRequest encoded by otlp-transformer 0.213.0; never regenerated during a test.
const LOGS =
  "CqgBCiAKHgoMc2VydmljZS5uYW1lEg4KDGxvZ3MtZml4dHVyZRKDAQoLCgZsb2dnZXISATESdAl7gNHo5ozjGBARGgVFUlJPUioOCgx0b2tlbj1oaWRkZW4yEwoFY291bnQSChj//////////38yFgoJbm9uZmluaXRlEgkhAAAAAAAA+H9KEBI0VniQq83vEjRWeJCrze9SCBI0VniQq83vWeeD0ejmjOMY";

const context = {
  checkout: "/fixture",
  workspaceId: TEST_WORKSPACE,
  sessionId: TEST_SESSION,
  turns: [],
};

test("pinned protobuf log decoder preserves uint64 time and ids and redacts the body", () => {
  const batch = decodeBatch(Buffer.from(LOGS, "base64"), "logs", "application/x-protobuf", context);
  expect(batch.logs).toHaveLength(1);
  expect(batch.logs[0]).toMatchObject({
    traceId: "1234567890abcdef1234567890abcdef",
    spanId: "1234567890abcdef",
    timeUnixNano: "1793432000000000123",
    observedTimeUnixNano: "1793432000000000999",
    severityNumber: 17,
    severityText: "ERROR",
    body: "[redacted]",
    attributes: { count: "9223372036854775807", nonfinite: "NaN" },
    resource: { "service.name": "logs-fixture" },
    scope: { name: "logger", version: "1" },
  });
});

test("decoder bounds recursive payloads before domain parsing and rejects truncated protobuf", () => {
  const deep = '{"unknown":'.repeat(40) + "null" + "}".repeat(40);
  expect(() => decodeBatch(Buffer.from(deep), "traces", "application/json", context)).toThrow();
  expect(() =>
    decodeBatch(
      Buffer.from(LOGS, "base64").subarray(0, 30),
      "logs",
      "application/x-protobuf",
      context
    )
  ).toThrow();
});

test("shared resource attributes cannot amplify a small request beyond the decoded batch budget", () => {
  const fixture = traceFixture(
    Array.from({ length: 100 }, (_, index) =>
      spanFixture({ id: (index + 1).toString(16).padStart(16, "0") })
    )
  );

  fixture.resourceSpans[0]!.resource.attributes.push({
    key: "large-resource",
    value: { stringValue: "x".repeat(256 * 1024) },
  });
  expect(() =>
    decodeBatch(Buffer.from(JSON.stringify(fixture)), "traces", "application/json", context)
  ).toThrow("Expanded OTLP batch");
});
