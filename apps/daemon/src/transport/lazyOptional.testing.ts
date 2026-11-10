import { strict as assert } from "node:assert";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer, Schema, Schedule, Stream } from "effect";
import {
  AllowedApp,
  AppId,
  DataRpcs,
  DesktopApp,
  DomainEvent,
  Workspace,
  AgentSession,
  TraceAvailability,
} from "@polaris/protocol";
import { Headers } from "effect/http";
import { Rpc } from "effect/rpc";
import { RequestId } from "effect/rpc/RpcMessage";
import { useFileSecretsForTests } from "../secrets/index.ts";
import { EventStore } from "../store/EventStore.ts";
import { DataSources } from "../data/services.ts";
import { TraceRuntime } from "../traces/runtimeService.ts";
import { TraceStore } from "../traces/storeService.ts";
import { ApprovalPolicy, WorkspaceTrust } from "../services.ts";
import { ComputerUseHostRpcs } from "../computerUse/group.ts";
import { lazyData, lazyDataHandlers } from "./lazyData.ts";
import { lazyTracesAt } from "./lazyTraces.ts";

const root = process.env.POLARIS_HOME!;

const options = {
  requestId: RequestId(1),
  headers: Headers.empty,
  client: new Rpc.ServerClient(1),
};

const implementationModules = () =>
  Object.keys(require.cache)
    .map((path) => path.replaceAll("\\", "/"))
    .filter(
      (path) =>
        /\/data\/(?:composition|sources|queries|database|schemaSnapshots)\.ts$/.test(path) ||
        /\/traces\/(?:composition|runtime|store|sessions|settings|receiverHandler|decoder|protobuf)\.ts$/.test(
          path
        ) ||
        path.includes("/traces/profiles/index.ts") ||
        path.includes("/push/seal.ts") ||
        path.includes("/node_modules/@hpke/") ||
        path.includes("/node_modules/sodium-") ||
        path.includes("/node_modules/noise-handshake/") ||
        path.includes("/node_modules/@opentelemetry/") ||
        path.includes("/node_modules/protobufjs/")
    );

/** The Reviewer, the Usage index and the accept handlers wait for their first request. */
const featureModules = () =>
  Object.keys(require.cache)
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) =>
      /\/apps\/daemon\/src\/(?:reviewer\/(?:index|run|walkthrough)|usage\/(?:UsageIndex|db|indexer)|accept\/(?:AcceptRpcs|draft))\.ts$/.test(
        path
      )
    );

/** Computer use's services, server, helper and installer wait for its first use. */
const computerUseModules = () =>
  Object.keys(require.cache)
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) =>
      /\/apps\/daemon\/src\/(?:computerUse\/(?:host|control|rpc|preview\/index)|harness\/desktop\/index|service\/computerUse\/index|install\/agentDesktop\/index|transport\/computerUseLive)\.ts$/.test(
        path
      )
    );

const seed = Effect.gen(function* () {
  const { initialSnapshot, stepModel } = yield* Effect.promise(
    () => import("../engine/session.testing.ts")
  );

  const record = stepModel(
    initialSnapshot(),
    { type: "start" },
    { harness: "codex", liveCoAttach: true, switchModel: true }
  ).next.machine.context.record!;

  const cwd = yield* Effect.promise(() => realpath(root));
  const store = yield* EventStore;
  yield* store.commit({
    commandId: null,
    decide: () =>
      Effect.succeed([
        DomainEvent.cases.WorkspaceRegistered.make({
          workspace: new Workspace({
            id: record.session.workspaceId,
            path: cwd,
            name: "fixture",
            isGitRepo: false,
            worktreeRoot: join(cwd, "worktrees"),
            hidden: false,
            registeredAt: record.session.createdAt,
          }),
        }),
        DomainEvent.cases.SessionCreated.make({
          session: new AgentSession({
            ...Schema.decodeUnknownSync(Schema.Struct(AgentSession.fields))(record.session),
            cwd,
          }),
        }),
        DomainEvent.cases.TurnStarted.make({ turn: record.turns[0]! }),
      ]),
  });

  return record.session.id;
});

const empty = async () => {
  const { engineServices, daemonCapabilities } = await import("./serve.ts");
  assert.deepEqual(implementationModules(), []);
  assert.deepEqual(featureModules(), []);
  assert.deepEqual(computerUseModules(), []);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(engineServices);
        assert.deepEqual(implementationModules(), []);
        assert.deepEqual(computerUseModules(), []);
        assert.equal(existsSync(join(root, "data.sqlite")), false);
        assert.equal(existsSync(join(root, "trace-tokens.json.seed")), false);
        assert.equal(daemonCapabilities.includes("data.schemaDiff"), true);
        assert.equal(daemonCapabilities.includes("traces.profiles.attach"), true);
      })
    )
  );
};

const data = async () => {
  await writeFile(
    join(root, ".env"),
    "DATABASE_URL=postgres://reader@db.example.test:5432/catalog\n"
  );

  const layers = lazyDataHandlers.pipe(
    Layer.provideMerge(lazyData),
    Layer.provideMerge(EventStore.layerSqlite(":memory:"))
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layers);
        assert.equal(existsSync(join(root, "data.sqlite")), false);
        yield* Effect.gen(function* () {
          const sessionId = yield* seed;
          const sources = yield* DataSources;
          const watch = yield* DataRpcs.accessHandler("data.sources.watch");
          const watched = watch({ sessionId }, options);
          const stream = Effect.isEffect(watched) ? Stream.fromQueue(yield* watched) : watched;

          const [fromService, fromRpc] = yield* Effect.all(
            [sources.list({ sessionId }), stream.pipe(Stream.take(1), Stream.runCollect)],
            { concurrency: "unbounded" }
          );

          assert.equal(fromService.length, 1);
          assert.deepEqual(fromRpc, [fromService]);
          const label = { text: "STAGING", colour: "blue" } as const;
          yield* sources.label({ sessionId, source: fromService[0]!.name, label });
          const refreshed = watch({ sessionId }, options);

          const refreshedStream = Effect.isEffect(refreshed)
            ? Stream.fromQueue(yield* refreshed)
            : refreshed;

          const pages = yield* refreshedStream.pipe(Stream.take(1), Stream.runCollect);
          assert.deepEqual(pages[0]![0]!.label, label);
        }).pipe(Effect.provide(context));
        assert.equal(existsSync(join(root, "data.sqlite")), true);
      })
    )
  );
};

/** What a Daemon saved before its restart is what the first `computerUse.*` request loads. */
const computerUse = async () => {
  const app = new DesktopApp({ id: AppId.make("com.example.notes"), name: "Notes", icon: null });
  const allowed = [new AllowedApp({ app, allowedAt: "2026-01-01T00:00:00.000Z" })];
  await writeFile(join(root, "computer-use.json"), JSON.stringify({ enabled: true, allowed }));
  const { lazyComputerUse, lazyComputerUseHandlers } = await import("./lazyComputerUse.ts");

  const layer = lazyComputerUseHandlers.pipe(
    Layer.provideMerge(lazyComputerUse),
    Layer.provideMerge(EventStore.layerSqlite(":memory:"))
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        assert.deepEqual(computerUseModules(), []);

        const list = yield* ComputerUseHostRpcs.accessHandler("computerUse.allowedApps").pipe(
          Effect.provide(context)
        );

        const listed = list({}, options);
        assert.deepEqual(Effect.isEffect(listed) ? yield* listed : listed, allowed);
        assert.notDeepEqual(computerUseModules(), []);
      })
    )
  );
};

const recovery = async () => {
  const { QueryLog } = await import("../data/queryLog.ts");
  const { DataDatabase } = await import("../data/database.ts");
  const { DataApprovals } = await import("../data/approvalService.ts");
  const { QueryLogEntry } = await import("@polaris/protocol");
  const { Database } = await import("bun:sqlite");
  const filename = join(root, "data.sqlite");

  await Effect.runPromise(
    QueryLog.use((log) =>
      log.put(
        new QueryLogEntry({
          id: "unfinished-write",
          checkout: root,
          source: { id: "app", name: "app" },
          sql: "UPDATE records SET amount = 1",
          state: "running",
          tool: "execute",
          author: { kind: "user" },
          at: new Date().toISOString(),
        })
      )
    ).pipe(
      Effect.provide(
        QueryLog.layer.pipe(
          Layer.provide(DataApprovals.layer),
          Layer.provide(DataDatabase.layerAt(filename)),
          Layer.provide(EventStore.layerSqlite(":memory:"))
        )
      )
    )
  );

  const db = new Database(filename);

  try {
    const state = () =>
      db
        .query<{ state: string }, []>(
          "SELECT json_extract(value,'$.state') AS state FROM data_query_log WHERE id='unfinished-write'"
        )
        .get()?.state;

    assert.equal(state(), "running");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(lazyData.pipe(Layer.provide(EventStore.layerSqlite(":memory:"))));
          assert.equal(state(), "unknown");
        })
      )
    );
  } finally {
    db.close();
  }
};

const migrations = async () => {
  await mkdir(join(root, "prisma", "migrations"), { recursive: true });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          lazyData.pipe(Layer.provideMerge(EventStore.layerSqlite(":memory:")))
        );

        assert.equal(existsSync(join(root, "data.sqlite")), false);
        yield* seed.pipe(Effect.provide(context));
        yield* Effect.suspend(() =>
          existsSync(join(root, "data.sqlite")) ? Effect.void : Effect.fail("not active")
        ).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced(10) }));
      })
    )
  );
};

const unregisteredTerminal = async () => {
  const layer = lazyTracesAt({ port: 0 }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(WorkspaceTrust, { trusted: () => Effect.succeed(false) }),
        Layer.succeed(ApprovalPolicy, { decide: () => Effect.succeed(null), readOnly: () => false })
      )
    ),
    Layer.provide(EventStore.layerSqlite(":memory:"))
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        const runtime = Context.get(context, TraceRuntime);

        const outcome = yield* runtime.terminalEnvironment(root, {}).pipe(
          Effect.map(() => "unexpected-success"),
          Effect.catchTag("TraceError", (error) => Effect.succeed(error.code))
        );

        assert.equal(outcome, "E-TRACE-NOT-FOUND");
        yield* runtime.launched?.(root, ["sh", "-c", "true"]) ?? Effect.void;
        assert.equal(existsSync(join(root, "trace-tokens.json.seed")), false);
        assert.deepEqual(
          implementationModules().filter((path) => !path.endsWith("/traces/sessions.ts")),
          []
        );
      })
    )
  );
};

const traces = async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  const trust = Layer.succeed(WorkspaceTrust, { trusted: () => Effect.succeed(false) });

  const policy = Layer.succeed(ApprovalPolicy, {
    decide: () => Effect.succeed(null),
    readOnly: () => false,
  });

  const layer = lazyTracesAt({ port }).pipe(
    Layer.provide(Layer.merge(trust, policy)),
    Layer.provideMerge(EventStore.layerSqlite(join(root, "events.sqlite")))
  );

  let endpoint = "";
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        assert.equal(existsSync(join(root, "trace-tokens.json.seed")), false);
        const id = yield* seed.pipe(Effect.provide(context));
        const setup = yield* Context.get(context, TraceRuntime).setup(id);
        assert.equal(TraceAvailability.guards.Listening(setup.availability), true);
        assert.equal(setup.endpoint?.startsWith(`http://127.0.0.1:${port}/otlp/`), true);
        endpoint = setup.endpoint!;
      })
    )
  );
  const { traceFixture, spanFixture, TRACE_ID } = await import("../traces/testing.ts");

  const post = () =>
    fetch(`${endpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(traceFixture([spanFixture()])),
    });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        const response = yield* Effect.promise(post);
        assert.equal(response.status, 200);
        const traces = Context.get(context, TraceStore);
        yield* traces.flush;
        const page = yield* traces.list(yield* Effect.promise(() => realpath(root)));
        assert.equal(page.traces[0]?.id, TRACE_ID);
        const events = Context.get(context, EventStore);
        const session = [...(yield* events.model).sessions.values()][0]!.session;
        yield* events.commit({
          commandId: null,
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.WorkspaceRemoved.make({ workspaceId: session.workspaceId }),
            ]),
        });
        const denied = yield* Effect.promise(post);
        assert.equal(denied.status, 401);
      })
    )
  );
  const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
  await rebound.stop(true);
};

useFileSecretsForTests();

await mkdir(root, { recursive: true });

switch (process.argv[2]) {
  case "empty":
    await empty();
    break;
  case "data":
    await data();
    break;
  case "unregistered-terminal":
    await unregisteredTerminal();
    break;
  case "traces":
    await traces();
    break;
  case "recovery":
    await recovery();
    break;
  case "computer-use":
    await computerUse();
    break;
  case "migrations":
    await migrations();
    break;
  default:
    throw new Error("Unknown lazy-service test scenario");
}
