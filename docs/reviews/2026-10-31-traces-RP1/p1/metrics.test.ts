import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TEST_SESSION, withTraceFixture } from "../../../../apps/daemon/src/traces/testing.ts";

// RP1 finding P1-1: Polaris now replaces the base OTLP endpoint even when the user already exports.
test("finding P1-1: an app's metrics still reach its own collector after Polaris injects its endpoint", () =>
  withTraceFixture(async (f) => {
    const received: string[] = [];

    const vendor = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        received.push(new URL(request.url).pathname);

        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });

    try {
      const env = await Effect.runPromise(
        f.runtime.environment(TEST_SESSION, {
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${vendor.port}`,
        })
      );

      // The OTel SDKs resolve the metrics URL this way from the environment they are given.
      const metrics =
        env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
        `${env.OTEL_EXPORTER_OTLP_ENDPOINT ?? `http://127.0.0.1:${vendor.port}`}/v1/metrics`;

      const response = await fetch(metrics, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceMetrics: [] }),
      });

      const deadline = Date.now() + 1500;

      while (!received.includes("/v1/metrics") && Date.now() < deadline) await Bun.sleep(10);

      expect({ status: response.status, vendor: received }).toEqual({
        status: 200,
        vendor: ["/v1/metrics"],
      });
    } finally {
      await vendor.stop(true);
    }
  }));
