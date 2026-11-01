import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { RpcTest } from "effect/rpc";
import { TraceTurn, TracesSettingsRpcs, TurnId } from "@polaris/protocol";
import { decodeBatch } from "./decoder.ts";
import { TraceSettings } from "./settings.ts";
import { TracesSettingsRpcsLive } from "./rpcs.ts";
import {
  withTraceFixture,
  traceFixture,
  spanFixture,
  TEST_SESSION,
  TEST_WORKSPACE,
  TRACE_ID,
  postTraces,
} from "./testing.ts";

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Forwarded request did not arrive");
    await Bun.sleep(5);
  }
};

const collector = () => {
  const received: Array<{ body: Uint8Array; headers: Headers; path: string }> = [];
  let status = 200;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({
        body: new Uint8Array(await request.arrayBuffer()),
        headers: request.headers,
        path: new URL(request.url).pathname,
      });

      return new Response(null, { status });
    },
  });

  return {
    received,
    server,
    endpoint: `http://127.0.0.1:${server.port}`,
    setStatus: (value: number) => {
      status = value;
    },
  };
};

for (const [signal, contentType, body] of [
  [
    "traces",
    "application/json; charset=utf-8",
    new TextEncoder().encode(` \n${JSON.stringify(traceFixture())}\n`),
  ],
  [
    "logs",
    "application/x-protobuf",
    Buffer.from(
      "CqgBCiAKHgoMc2VydmljZS5uYW1lEg4KDGxvZ3MtZml4dHVyZRKDAQoLCgZsb2dnZXISATESdAl7gNHo5ozjGBARGgVFUlJPUioOCgx0b2tlbj1oaWRkZW4yEwoFY291bnQSChj//////////38yFgoJbm9uZmluaXRlEgkhAAAAAAAA+H9KEBI0VniQq83vEjRWeJCrze9SCBI0VniQq83vWeeD0ejmjOMY",
      "base64"
    ),
  ],
] as const)
  test(`receiver forwards exact ${signal} bytes and app headers to the launch origin`, () =>
    withTraceFixture(async (f) => {
      const target = collector();

      try {
        await Effect.runPromise(
          f.runtime.environment(TEST_SESSION, {
            OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint,
            OTEL_EXPORTER_OTLP_HEADERS: "x-configured=private-config",
          })
        );

        const response = await fetch(`${f.endpoint}/v1/${signal}`, {
          method: "POST",
          headers: {
            "content-type": contentType,
            authorization: "Bearer private-constructor",
            "x-custom": "app-header",
            "x-configured": "incoming-must-not-win",
          },
          body,
        });

        expect(response.status).toBe(200);
        await until(() => f.forwarding.stats.delivered === 1);
        expect(target.received[0]!.body).toEqual(new Uint8Array(body));
        expect(target.received[0]!.headers.get("content-type")).toBe(contentType);
        expect(target.received[0]!.headers.get("authorization")).toBe("Bearer private-constructor");
        expect(target.received[0]!.headers.get("x-configured")).toBe("private-config");
        expect(target.received[0]!.path).toBe(`/v1/${signal}`);

        if (signal === "traces") {
          const local = await Effect.runPromise(f.store.get(f.root, TRACE_ID));
          expect(local.spans[0]?.attributes["http.request.header.authorization"]).toBe(
            "[redacted]"
          );
        }

        expect(
          (await readFile(join(f.root, "traces.sqlite"))).includes(
            Buffer.from("private-constructor")
          )
        ).toBe(false);
        expect(
          JSON.stringify(await Effect.runPromise(f.settings.get(TEST_WORKSPACE)))
        ).not.toContain("private-");
      } finally {
        await target.server.stop(true);
      }
    }));

test("collector outage keeps Polaris copy and live off switch cancels queued retries", () =>
  withTraceFixture(async (f) => {
    const target = collector();
    target.setStatus(503);

    try {
      await Effect.runPromise(
        f.settings.patch(TEST_WORKSPACE, {
          forwardTo: { url: `${target.endpoint}/v1/traces`, headerNames: [] },
        })
      );
      expect((await postTraces(f.endpoint!)).status).toBe(200);
      expect((await Effect.runPromise(f.store.get(f.root, TRACE_ID))).spans).toHaveLength(1);
      await until(() => f.forwarding.stats.failed > 0);
      await Effect.runPromise(f.settings.patch(TEST_WORKSPACE, { forwarding: false }));
      const before = target.received.length;
      expect(
        (await postTraces(f.endpoint!, traceFixture([spanFixture({ traceId: "b".repeat(32) })])))
          .status
      ).toBe(200);
      await Bun.sleep(100);
      expect(target.received).toHaveLength(before);
      expect(f.forwarding.stats.queued).toBe(0);
      expect((await Effect.runPromise(f.store.list(f.root))).total).toBe(2);
    } finally {
      await target.server.stop(true);
    }
  }));

test("local collection can be off while forwarding stays on", () =>
  withTraceFixture(async (f) => {
    const target = collector();

    try {
      await Effect.runPromise(
        f.settings.patch(TEST_WORKSPACE, {
          enabled: false,
          forwardTo: { url: `${target.endpoint}/v1/traces`, headerNames: [] },
        })
      );
      expect((await postTraces(f.endpoint!)).status).toBe(200);
      await until(() => f.forwarding.stats.delivered === 1);
      expect((await Effect.runPromise(f.store.list(f.root))).total).toBe(0);
    } finally {
      await target.server.stop(true);
    }
  }));

test(
  "real @vercel/otel second exporter reaches vendor once while Polaris retains its copy",
  () =>
    withTraceFixture(async (f) => {
      const target = collector();
      const script = new URL("./fixtures/second-exporter.mjs", import.meta.url).pathname;

      try {
        await writeFile(
          join(f.root, "package.json"),
          JSON.stringify({ dependencies: { "@vercel/otel": "2.1.1" } })
        );
        await writeFile(join(f.root, "instrumentation.ts"), await readFile(script, "utf8"));
        const env = { ...process.env };

        for (const key of Object.keys(env)) if (key.startsWith("OTEL_")) delete env[key];

        const injected = await Effect.runPromise(
          f.runtime.environment(TEST_SESSION, {
            OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint,
            TEST_VENDOR_URL: `${target.endpoint}/v1/traces`,
          })
        );

        expect(
          (await Effect.runPromise(f.settings.get(TEST_WORKSPACE))).detectedExporters.some(
            (e) => e.alreadyExporting
          )
        ).toBe(true);

        const child = Bun.spawn(["node", script], {
          env: {
            ...env,
            ...injected,
            TEST_VENDOR_URL: `${target.endpoint}/v1/traces`,
            OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        });

        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);

        expect(exit, stderr).toBe(0);

        const result = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ traceId: Schema.String }))
        )(stdout.trim());

        expect((await Effect.runPromise(f.store.get(f.root, result.traceId))).spans[0]?.name).toBe(
          "vendor-once"
        );
        await until(() => f.forwarding.stats.queued === 0);
        expect(target.received).toHaveLength(1);

        const vendorCopy = decodeBatch(
          target.received[0]!.body,
          "traces",
          "application/x-protobuf",
          f.context
        );

        expect(vendorCopy.spans.map((span) => span.traceId)).toEqual([result.traceId]);
        expect(f.forwarding.stats.delivered).toBe(0);
      } finally {
        await target.server.stop(true);
      }
    }),
  30_000
);

test("settings RPC patches resolve through the shared service", () =>
  withTraceFixture(async (f) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* RpcTest.makeClient(TracesSettingsRpcs);
          expect(
            yield* rpc["traces.setSettings"]({
              workspaceId: TEST_WORKSPACE,
              settings: { forwarding: false },
            })
          ).toMatchObject({ forwarding: false, enabled: true });
          expect(yield* rpc["traces.settings"]({ workspaceId: TEST_WORKSPACE })).toMatchObject({
            forwarding: false,
          });
        })
      ).pipe(
        Effect.provide(TracesSettingsRpcsLive),
        Effect.provide(Layer.succeed(TraceSettings, f.settings))
      )
    );
  }));

test("a pending local store never delays delivery to the collector", async () => {
  let release: () => void = () => {};

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  await withTraceFixture(
    async (f) => {
      const target = collector();
      let response: Promise<Response> | undefined;
      let completed = false;

      try {
        await Effect.runPromise(
          f.settings.patch(TEST_WORKSPACE, {
            forwardTo: { url: `${target.endpoint}/v1/traces`, headerNames: [] },
          })
        );
        response = postTraces(f.endpoint!).then((value) => {
          completed = true;

          return value;
        });
        await until(() => f.forwarding.stats.delivered === 1);
        expect(completed).toBe(false);
        release();
        expect((await response).status).toBe(200);
        expect((await Effect.runPromise(f.store.get(f.root, TRACE_ID))).spans).toHaveLength(1);
      } finally {
        release();
        await response;
        await target.server.stop(true);
      }
    },
    { beforeIngest: () => blocked }
  );
});

for (const kind of ["session", "terminal"] as const)
  test(`${kind} child endpoints forward while preserving launch attribution`, () =>
    withTraceFixture(async (f) => {
      const target = collector();

      const launched = TraceTurn.make({
        sessionId: TEST_SESSION,
        id: TurnId.make("launch"),
        number: 2,
      });

      const current = TraceTurn.make({
        sessionId: TEST_SESSION,
        id: TurnId.make("current"),
        number: 5,
      });

      f.state.turns = [
        { turn: launched, start: "0", end: "1" },
        { turn: current, start: "1", end: null },
      ];

      try {
        const source = {
          OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint,
          OTEL_EXPORTER_OTLP_HEADERS: "x-collector=private-child-header",
        };

        const parent = await Effect.runPromise(
          kind === "session"
            ? f.runtime.environment(TEST_SESSION, source)
            : f.runtime.terminalEnvironment(f.root, source)
        );

        const child = await Effect.runPromise(
          kind === "session"
            ? f.runtime.environment(TEST_SESSION, parent, launched.id)
            : f.runtime.terminalEnvironment(f.root, parent)
        );

        const body = JSON.stringify(traceFixture());

        const response = await fetch(child.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });

        expect(response.status).toBe(200);
        await until(() => f.forwarding.stats.delivered === 1);
        expect(target.received[0]!.body).toEqual(new TextEncoder().encode(body));
        expect(target.received[0]!.headers.get("x-collector")).toBe("private-child-header");
        const detail = await Effect.runPromise(f.store.get(f.root, TRACE_ID));
        expect(detail.spans[0]?.polaris).toMatchObject({
          checkout: f.root,
          sessionId: kind === "session" ? TEST_SESSION : null,
          launchedTurn: kind === "session" ? launched : null,
          turn: kind === "session" ? current : null,
        });
      } finally {
        await target.server.stop(true);
      }
    }));
