import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";
import { join } from "node:path";
import { Effect } from "effect";
import {
  DEFAULT_DEVELOPER_MODE,
  type DataSource,
  DeveloperMode,
  TraceAvailability,
  TraceTurn,
  TurnId,
  type WorkspaceId,
} from "@polaris/protocol";
import { TraceStore } from "../../traces/index.ts";
import { spanFixture, traceFixture, TEST_SESSION, TEST_WORKSPACE } from "../../traces/testing.ts";
import type { TraceRuntime } from "../../traces/index.ts";
import { sessionTraceTools } from "../sessions/traces.ts";
import { unavailableSessions } from "../sessions/index.ts";
import { attachSessionTools, constellationTools, type BoundTool } from "./index.ts";
import { fakeCommands } from "../testing.ts";
import { bindings } from "./data.testing.ts";
import { traceTools } from "./traces.ts";

export const NOW = BigInt(Date.now()) * 1_000_000n;

/** `trace_capture`'s wait for late batches here: the test ingests each batch itself. */
export const CAPTURE_TEST_GRACE_MS = 50;

export const turn = TraceTurn.make({
  sessionId: TEST_SESSION,
  id: TurnId.make("turn-12"),
  number: 12,
});

export const context = {
  checkout: "/tmp/trace-tool-checkout",
  workspaceId: TEST_WORKSPACE,
  sessionId: TEST_SESSION,
  turns: [{ turn, start: (NOW - 60_000_000_000n).toString(), end: null }],
};

const emptyEvents = (): ReturnType<typeof spanFixture>["events"] => [];

export const makeSpan = (
  id: number,
  parent?: number,
  name = "POST /invoices/overdue",
  ms = 840,
  at = 0,
  traceId?: string
) => ({
  ...spanFixture({
    id: id.toString(16).padStart(16, "0"),
    ...(parent === undefined ? undefined : { parentId: parent.toString(16).padStart(16, "0") }),
    start: (NOW + BigInt(Math.round(at * 1e6))).toString(),
    ...(traceId === undefined ? undefined : { traceId }),
  }),
  name,
  endTimeUnixNano: (NOW + BigInt(Math.round((at + ms) * 1e6))).toString(),
  events: emptyEvents(),
});

export const withStoredTools = async (
  run: (fixture: {
    ingest: (
      spans: ReturnType<typeof makeSpan>[],
      service?: string,
      checkout?: string,
      version?: string
    ) => Promise<void>;
    store: TraceStore["Service"];
    tool: (name: string) => BoundTool;
    catalogs: ReadonlyArray<ReadonlyArray<BoundTool>>;
    setAvailable: (value: boolean) => void;
    setSources: (value: ReadonlyArray<DataSource>) => void;
    setDeveloperMode: (effective: boolean, polarisWorkspaceId?: WorkspaceId) => void;
    sourceCalls: () => number;
  }) => Promise<void>
) => {
  const root = newTempDir("t2-traces-", { short: true });

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* TraceStore;
          let available = true;
          let sources: ReadonlyArray<DataSource> = [];
          let sourceCalls = 0;
          let developerMode: DeveloperMode = DEFAULT_DEVELOPER_MODE;

          const setup: TraceRuntime["Service"]["setup"] = () =>
            Effect.succeed({
              availability: available
                ? TraceAvailability.cases.Listening.make({})
                : TraceAvailability.cases.Unavailable.make({
                    code: "port",
                    message: "Port 4319 is in use.",
                    owner: "fixture",
                  }),
              endpoint: "http://127.0.0.1:4319/otlp/test-endpoint",
              userExported: false,
            });

          const sessions = sessionTraceTools(
            store,
            { setup },
            { session: () => Effect.succeed(context) },
            {
              list: () =>
                Effect.sync(() => {
                  sourceCalls++;

                  return sources;
                }),
            },
            Effect.sync(() => developerMode),
            CAPTURE_TEST_GRACE_MS
          );

          const catalogs = bindings.map((binding) => {
            const commands = fakeCommands().commands;
            attachSessionTools(commands, { ...unavailableSessions, traces: sessions });

            return constellationTools(binding, commands);
          });

          const tools = traceTools(TEST_SESSION, { ...unavailableSessions, traces: sessions });
          yield* Effect.promise(() =>
            run({
              store,
              catalogs,
              tool: (name) => {
                const tool = tools.find((tool) => tool.name === name);

                if (tool === undefined) throw new Error(`Missing ${name}`);

                return tool;
              },
              setAvailable: (value) => {
                available = value;
              },
              setSources: (value) => {
                sources = value;
              },
              sourceCalls: () => sourceCalls,
              setDeveloperMode: (effective, polarisWorkspaceId = TEST_WORKSPACE) => {
                developerMode = DeveloperMode.make({
                  stored: effective,
                  leases: 0,
                  fromSource: false,
                  effective,
                  polarisWorkspaceId,
                  polarisWorkspaceSource: "remote",
                });
              },
              ingest: async (
                spans,
                service = "ledger-api",
                checkout = context.checkout,
                version
              ) => {
                const batch = traceFixture(spans);
                const { attributes } = batch.resourceSpans[0]!.resource;
                attributes[0]!.value.stringValue = service;

                if (version !== undefined)
                  attributes.push({ key: "service.version", value: { stringValue: version } });
                await Effect.runPromise(
                  store.ingest({
                    signal: "traces",
                    contentType: "application/json",
                    bytes: new TextEncoder().encode(JSON.stringify(batch)),
                    context: { ...context, checkout },
                  })
                );
              },
            })
          );
        }).pipe(Effect.provide(TraceStore.layerAt(join(root, "traces.sqlite"))))
      )
    );
  } finally {
    await removeTempDirSettled(root);
  }
};
