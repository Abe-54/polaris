import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SessionId, WorkspaceId, TraceError, type TraceTurn } from "@polaris/protocol";
import { traceReceiver } from "./receiver.ts";
import { TraceRuntime } from "./runtime.ts";
import { TraceSessions } from "./sessions.ts";
import { TraceStore } from "./store.ts";
import type { TraceWorkerOptions } from "./workerClient.ts";
import type { ExportTraces } from "./otlp.ts";
import type { IngestContext } from "./ingest.ts";

export const TEST_SESSION = SessionId.make("trace-test");

export const TEST_WORKSPACE = WorkspaceId.make("trace-workspace");

export const TRACE_ID = "1234567890abcdef1234567890abcdef";

export const SPAN_ID = "1234567890abcdef";

export const timeNow = () => (BigInt(Date.now()) * 1_000_000n + 123n).toString();

export const spanFixture = (
  options: {
    traceId?: string;
    id?: string;
    start?: string;
    error?: boolean;
    parentId?: string;
  } = {}
) => {
  const start = options.start ?? timeNow();

  return {
    traceId: options.traceId ?? TRACE_ID,
    spanId: options.id ?? SPAN_ID,
    parentSpanId: options.parentId ?? "",
    name: "POST /orders",
    kind: 2,
    startTimeUnixNano: start,
    endTimeUnixNano: (BigInt(start) + 12_345_678n).toString(),
    status: { code: options.error ? 2 : 1 },
    attributes: [
      { key: "http.route", value: { stringValue: "/orders" } },
      { key: "http.request.header.authorization", value: { stringValue: "private-auth" } },
      {
        key: "nested",
        value: {
          kvlistValue: { values: [{ key: "apiKey", value: { stringValue: "private-nested" } }] },
        },
      },
      { key: "large", value: { intValue: "9223372036854775807" } },
    ],
    events: [
      {
        name: "exception",
        timeUnixNano: start,
        attributes: [
          { key: "exception.message", value: { stringValue: "password=private-event" } },
        ],
      },
    ],
    links: [
      {
        traceId: "abcdef1234567890abcdef1234567890",
        spanId: "abcdef1234567890",
        attributes: [{ key: "cookie", value: { stringValue: "private-cookie" } }],
      },
    ],
  };
};

export const traceFixture = (spans = [spanFixture()]) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "fixture-service" } },
          { key: "token", value: { stringValue: "private-resource" } },
        ],
      },
      scopeSpans: [
        {
          scope: {
            name: "fixture",
            version: "1",
            attributes: [{ key: "secret", value: { stringValue: "private-scope" } }],
          },
          spans,
        },
      ],
    },
  ],
});

export interface TraceFixture {
  readonly root: string;
  readonly port: number;
  readonly endpoint: string | null;
  readonly store: TraceStore["Service"];
  readonly runtime: TraceRuntime["Service"];
  readonly state: {
    active: boolean;
    turns: ReadonlyArray<{ turn: TraceTurn; start: string; end: string | null }>;
  };
  readonly context: IngestContext;
}

export interface FixtureOptions extends TraceWorkerOptions {
  readonly port?: number;
  readonly owner?: (port: number) => Promise<string | null>;
}

export const withTraceFixture = async (
  run: (fixture: TraceFixture) => Promise<void>,
  options: FixtureOptions = {}
) => {
  const root = await mkdtemp("/tmp/t1-tr-");

  const probe =
    options.port === undefined
      ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
      : null;

  const port = options.port ?? probe!.port!;
  await probe?.stop(true);
  const state: TraceFixture["state"] = { active: true, turns: [] };

  const context = {
    checkout: root,
    workspaceId: TEST_WORKSPACE,
    sessionId: TEST_SESSION,
    turns: [],
  } satisfies IngestContext;

  const sessions = Layer.succeed(
    TraceSessions,
    TraceSessions.of({
      session: (id) =>
        id === TEST_SESSION
          ? Effect.succeed({ ...context, turns: state.turns })
          : Effect.fail(
              new TraceError({
                code: "E-TRACE-NOT-FOUND",
                message: "Unknown session",
                fix: "Select a session",
              })
            ),
      workspace: () => Effect.succeed({ ...context, sessionId: null, turns: [] }),
      active: () => Effect.succeed(state.active),
      workspaceActive: () => Effect.succeed(state.active),
    })
  );

  const layer = TraceRuntime.layerAt(join(root, "tokens.json"), port).pipe(
    Layer.provideMerge(TraceStore.layerAt(join(root, "traces.sqlite"), options)),
    Layer.provideMerge(sessions)
  );

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* TraceStore;
          const runtime = yield* TraceRuntime;
          yield* traceReceiver({ ...options, port });
          const env = yield* runtime.environment(TEST_SESSION, {});
          yield* Effect.promise(() =>
            run({
              root,
              port,
              endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
              store,
              runtime,
              state,
              context,
            })
          );
        }).pipe(Effect.provide(layer))
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const postTraces = (endpoint: string, data: typeof ExportTraces.Type = traceFixture()) =>
  fetch(`${endpoint}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
