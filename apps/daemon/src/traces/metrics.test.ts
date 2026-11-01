import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { TEST_SESSION, TEST_WORKSPACE, withTraceFixture } from "./testing.ts";
import type { TraceEnvironment } from "./runtime.ts";

const destinations: ReadonlyArray<{
  name: string;
  base?: string;
  metrics?: string;
  expected: string;
}> = [
  { name: "base endpoint", base: "", expected: "/v1/metrics" },
  { name: "trailing slash", base: "/", expected: "/v1/metrics" },
  {
    name: "base path and query",
    base: "/otlp/?tenant=app",
    expected: "/otlp/v1/metrics?tenant=app",
  },
  {
    name: "explicit metrics endpoint",
    base: "/unused",
    metrics: "/custom?tenant=metrics",
    expected: "/custom?tenant=metrics",
  },
  { name: "metrics endpoint alone", metrics: "/metrics-only", expected: "/metrics-only" },
];

for (const launch of ["session", "terminal"] as const) {
  for (const destination of destinations) {
    test(`finding P1-1: an app's metrics still reach its own collector after Polaris injects its endpoint (${launch}, ${destination.name})`, () =>
      withTraceFixture(async (f) => {
        const received: Array<{ path: string; body: string }> = [];

        const vendor = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            const url = new URL(request.url);

            received.push({ path: url.pathname + url.search, body: await request.text() });

            return new Response("{}", { headers: { "content-type": "application/json" } });
          },
        });

        try {
          const origin = `http://127.0.0.1:${vendor.port}`;

          const source: TraceEnvironment = {
            OTEL_EXPORTER_OTLP_ENDPOINT:
              destination.base === undefined ? undefined : origin + destination.base,
            OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
              destination.metrics === undefined ? undefined : origin + destination.metrics,
          };

          const injected = await Effect.runPromise(
            launch === "session"
              ? f.runtime.environment(TEST_SESSION, source)
              : f.runtime.terminalEnvironment(f.root, source)
          );

          const env = { ...source, ...injected };

          // OTel HTTP exporters prefer the metrics endpoint over the base endpoint.
          const metrics =
            env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
            `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`;

          const body = JSON.stringify({ resourceMetrics: [] });

          const response = await fetch(metrics, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });

          expect({ status: response.status, vendor: received }).toEqual({
            status: 200,
            vendor: [{ path: destination.expected, body }],
          });
          expect(injected.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toMatch(/\/otlp\/.+\/v1\/traces$/);
          expect(injected.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toMatch(/\/otlp\/.+\/v1\/logs$/);
        } finally {
          await vendor.stop(true);
        }
      }));
  }

  test(`${launch} injects no metrics URL without an app endpoint, even with saved and repository collectors`, () =>
    withTraceFixture(async (f) => {
      await writeFile(
        join(f.root, ".env"),
        "OTEL_EXPORTER_OTLP_ENDPOINT=https://repository.test\n"
      );
      await Effect.runPromise(
        f.settings.patch(TEST_WORKSPACE, {
          forwardTo: { url: "https://saved.test/v1/traces", headerNames: [] },
        })
      );

      for (const source of [
        {},
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.test/v1/traces" },
        { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.test/v1/logs" },
        { OTEL_EXPORTER_OTLP_ENDPOINT: f.endpoint! },
      ]) {
        const injected = await Effect.runPromise(
          launch === "session"
            ? f.runtime.environment(TEST_SESSION, source)
            : f.runtime.terminalEnvironment(f.root, source)
        );

        expect(injected).not.toHaveProperty("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT");
      }
    }));
}
