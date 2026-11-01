import { expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { detectExporters } from "./detection.ts";
import {
  postTraces,
  spanFixture,
  TEST_SESSION,
  TEST_WORKSPACE,
  TRACE_ID,
  traceFixture,
  withTraceFixture,
} from "./testing.ts";

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Forwarding did not settle");
    await Bun.sleep(5);
  }
};

const collector = () => {
  const received: Array<{ headers: Headers; body: string }> = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({ headers: request.headers, body: await request.text() });

      return new Response(null, { status: 200 });
    },
  });

  return { received, server, url: `http://127.0.0.1:${server.port}/v1/traces` };
};

test("repository AXIOM_URL cannot receive launch credentials through the receiver", () =>
  withTraceFixture(async (f) => {
    const target = collector();
    const launchRequests: Headers[] = [];
    const originalFetch = globalThis.fetch;
    // Only the default vendor service is faked; the receiver and repository collector use HTTP.

    const vendorFetch = (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      if (input === "https://api.axiom.co/v1/traces") {
        launchRequests.push(new Headers(init?.headers));

        return Promise.resolve(new Response(null, { status: 200 }));
      }

      return originalFetch(input, init);
    };

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(vendorFetch, { preconnect: originalFetch.preconnect })
    );

    try {
      await writeFile(join(f.root, ".env"), `AXIOM_URL=${new URL(target.url).origin}\n`);
      await Effect.runPromise(
        f.runtime.environment(TEST_SESSION, {
          AXIOM_TOKEN: "source-only-token",
          AXIOM_DATASET: "source-only-dataset",
        })
      );
      expect((await postTraces(f.endpoint!)).status).toBe(200);
      await until(() => f.forwarding.stats.delivered === 1);
      expect(target.received.map((request) => request.headers.get("authorization"))).toEqual([]);
      expect(launchRequests[0]?.get("authorization")).toBe("Bearer source-only-token");
      expect(launchRequests[0]?.get("x-axiom-dataset")).toBe("source-only-dataset");
      expect((await Effect.runPromise(f.store.get(f.root, TRACE_ID))).spans).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
      await target.server.stop(true);
    }
  }));

for (const variable of ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "AXIOM_OTLP_ENDPOINT"]) {
  test(`repository ${variable} forwards only after the user saves its URL`, () =>
    withTraceFixture(async (f) => {
      const target = collector();

      try {
        await writeFile(join(f.root, ".env"), `${variable}=${target.url}\n`);
        await Effect.runPromise(f.runtime.environment(TEST_SESSION, {}));
        expect((await postTraces(f.endpoint!)).status).toBe(200);
        await Bun.sleep(50);
        expect(target.received).toEqual([]);
        expect((await Effect.runPromise(f.store.get(f.root, TRACE_ID))).spans).toHaveLength(1);
        expect((await Effect.runPromise(f.settings.get(TEST_WORKSPACE))).forwardTo).toBeNull();
        expect((await detectExporters(f.root, {})).suggestedCollector?.traces).toBe(target.url);

        await Effect.runPromise(
          f.settings.patch(TEST_WORKSPACE, { forwardTo: { url: target.url, headerNames: [] } })
        );
        const nextId = "b".repeat(32);
        expect(
          (await postTraces(f.endpoint!, traceFixture([spanFixture({ traceId: nextId })]))).status
        ).toBe(200);
        await until(() => f.forwarding.stats.delivered === 1);
        expect(target.received).toHaveLength(1);
        expect(target.received[0]?.body).toContain(nextId);
        expect(target.received[0]?.headers.get("authorization")).toBeNull();
      } finally {
        await target.server.stop(true);
      }
    }));
}

test("a vendor collector entirely in the launch environment still receives credentials", () =>
  withTraceFixture(async (f) => {
    const target = collector();

    try {
      await Effect.runPromise(
        f.runtime.environment(TEST_SESSION, {
          AXIOM_URL: new URL(target.url).origin,
          AXIOM_TOKEN: "launch-token",
          AXIOM_DATASET: "launch-dataset",
        })
      );
      expect((await postTraces(f.endpoint!)).status).toBe(200);
      await until(() => f.forwarding.stats.delivered === 1);
      expect(target.received[0]?.headers.get("authorization")).toBe("Bearer launch-token");
      expect(target.received[0]?.headers.get("x-axiom-dataset")).toBe("launch-dataset");
    } finally {
      await target.server.stop(true);
    }
  }));

test("a saved target on another origin receives no incoming credentials", () =>
  withTraceFixture(async (f) => {
    const original = collector();
    const target = collector();

    try {
      await Effect.runPromise(
        f.runtime.environment(TEST_SESSION, {
          AXIOM_URL: new URL(original.url).origin,
          AXIOM_TOKEN: "launch-token",
          AXIOM_DATASET: "launch-dataset",
          OTEL_EXPORTER_OTLP_HEADERS: "x-unusual=launch-secret,content-type=application/json",
          OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-log-field=launch-log-secret",
        })
      );
      await Effect.runPromise(
        f.settings.patch(TEST_WORKSPACE, { forwardTo: { url: target.url, headerNames: [] } })
      );
      const body = JSON.stringify(traceFixture());

      const response = await fetch(`${f.endpoint}/v1/traces`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer app-secret",
          cookie: "session=app-secret",
          "x-api-key": "app-secret",
          "x-token-value": "app-secret",
          "x-axiom-dataset": "app-secret",
          "x-honeycomb-team": "app-secret",
          "x-unusual": "launch-secret",
          "x-log-field": "launch-log-secret",
          "x-otel-detail": "safe-metadata",
        },
        body,
      });

      expect(response.status).toBe(200);
      await until(() => f.forwarding.stats.delivered === 1);
      const received = target.received[0]!;
      expect(received.body).toBe(body);
      expect([...received.headers.values()].some((value) => value.includes("secret"))).toBe(false);
      expect(received.headers.get("x-otel-detail")).toBe("safe-metadata");
      expect(received.headers.get("content-type")).toBe("application/json");
      expect(original.received).toEqual([]);
      expect((await Effect.runPromise(f.settings.get(TEST_WORKSPACE))).forwardTo).toEqual({
        url: target.url,
        headerNames: [],
        passesAppHeaders: false,
      });
    } finally {
      await original.server.stop(true);
      await target.server.stop(true);
    }
  }));

test("a saved launch origin retains app credentials and reports only static header metadata", () =>
  withTraceFixture(async (f) => {
    const target = collector();

    try {
      await Effect.runPromise(
        f.runtime.environment(TEST_SESSION, {
          AXIOM_URL: new URL(target.url).origin,
          AXIOM_TOKEN: "launch-token",
          AXIOM_DATASET: "launch-dataset",
          OTEL_EXPORTER_OTLP_HEADERS: "x-unusual=launch-secret,content-type=application/json",
        })
      );
      await Effect.runPromise(
        f.settings.patch(TEST_WORKSPACE, { forwardTo: { url: target.url, headerNames: [] } })
      );
      const before = await Effect.runPromise(f.settings.get(TEST_WORKSPACE));
      expect(before.forwardTo).toEqual({
        url: target.url,
        headerNames: ["x-unusual"],
        passesAppHeaders: true,
      });
      expect(
        (
          await fetch(`${f.endpoint}/v1/traces`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer app-secret",
              "x-unusual": "launch-secret",
            },
            body: JSON.stringify(traceFixture()),
          })
        ).status
      ).toBe(200);
      await until(() => f.forwarding.stats.delivered === 1);
      expect(target.received[0]?.headers.get("authorization")).toBe("Bearer app-secret");
      expect(target.received[0]?.headers.get("x-unusual")).toBe("launch-secret");
      expect((await Effect.runPromise(f.settings.get(TEST_WORKSPACE))).forwardTo).toEqual(
        before.forwardTo
      );
    } finally {
      await target.server.stop(true);
    }
  }));
