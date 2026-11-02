import { expect } from "bun:test";
import { join } from "node:path";
import {
  CommandId,
  Command,
  Constellation,
  ConstellationSettings,
  DomainEvent,
  HostResourcesSnapshot,
  Task,
  Workspace,
  WorkerPlacement,
  TurnItem,
  WorktreeSetup,
  PlanOperation,
  SetConstellationStateAction,
} from "@polaris/protocol";
import { Effect, Layer, Latch, Stream, Fiber, Option } from "effect";
import { Engine, EngineConfig } from "../../engine/Engine.ts";
import { C, CID, HOST, LEAD, WS, G, task } from "../../engine/constellation.testing.ts";
import { decideSession } from "../../engine/session.ts";
import {
  fakeServices,
  makeFakes,
  makeFakeDriver,
  completesTurns,
  type FakeDriver,
  pendingReviewCheckoutGit,
  waitFor,
  waitUntil,
} from "../../engine/testing.ts";
import { HarnessEvent } from "../../harness/HarnessDriver.ts";
import { makeRepo, removeTempDir } from "../../git/testing.ts";
import { McpTokens } from "../../mcp/tokens.ts";
import { HostResources } from "../../resources/index.ts";
import { patchSession } from "../../store/model.ts";
import { EventStore } from "../../store/EventStore.ts";
import { session } from "../delivery/testing.ts";
import { taskData } from "../data.ts";
import { ConstellationLiveness } from "../liveness.ts";
import { ConstellationOwner } from "../runtime.ts";
import { Constellations } from "../service.ts";
import { constellationGitLayer } from "../transfers/index.ts";
import { ConstellationHarness } from "./attachments.ts";
import { constellationServices } from "./index.ts";
import { trustedSetup } from "../setup/trust.testing.ts";
import { posixTest } from "../../platform/testing.ts";

const test = posixTest(
  "setup commands here are POSIX shell lines; Windows runs setup under cmd.exe (ENG-318)"
);

test("production composition acquires a slot before first Turn, installs MCP/environment and publishes Harness liveness", async () => {
  const root = await makeRepo({
    "README.md": "hello\n",
    ".gitignore": "*.sqlite*\nnode_modules/\n",
  });

  const driver = makeFakeDriver("codex", {
    steer: true,
    onTurn: (input) =>
      input.prompt.startsWith("Write a compact handover")
        ? completesTurns()(input)
        : [HarnessEvent.TurnStarted({ turnId: input.turnId, prompt: input.prompt })],
    onInterrupt: (session) => [
      HarnessEvent.TurnEnded({
        turnId: session.turns.at(-1)!.turnId,
        status: "interrupted",
        error: null,
      }),
    ],
  });

  let initialOpens = 0;
  const gate = Latch.makeUnsafe(false);
  let holds = 0;

  const empty = Effect.succeed(
    HostResourcesSnapshot.make({
      resources: [],
      resourceLeases: [],
      waiting: [],
      overdueLeaseIds: [],
      workerCap: { cap: 1, default: 1, working: 0, waiting: 0 },
    })
  );

  const resources = Layer.succeed(HostResources)({
    get: empty,
    declare: () => empty,
    remove: () => empty,
    release: () => empty,
    setWorkerCap: () => empty,
    acquire: () => Effect.die("unused process lease"),
    acquireWorker: () =>
      Effect.andThen(
        gate.await,
        Effect.acquireRelease(
          Effect.sync(() => {
            holds++;
          }),
          () =>
            Effect.sync(() => {
              holds--;
            })
        )
      ),
  });

  const store = EventStore.layerSqlite(join(root, "state.sqlite"));

  const base = Layer.mergeAll(
    constellationGitLayer(join(root, "transfers.sqlite")),
    McpTokens.layer(join(root, "mcp.sqlite")),
    ConstellationLiveness.layer,
    resources,
    Layer.succeed(ConstellationOwner)(HOST),
    fakeServices(makeFakes(), [driver]),
    pendingReviewCheckoutGit,
    Layer.succeed(EngineConfig)({ idleTimeout: "1 hour", checkpointSweepInterval: null })
  ).pipe(Layer.provideMerge(store));

  const attachments = ConstellationHarness.layer.pipe(Layer.provideMerge(base));

  const seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* EventStore;
      const at = new Date().toISOString();
      const lead = patchSession(session(LEAD), { cwd: root });
      yield* store
        .commit({
          commandId: CommandId.make("seed"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.WorkspaceRegistered.make({
                workspace: new Workspace({
                  id: WS,
                  name: "repo",
                  path: root,
                  isGitRepo: true,
                  worktreeRoot: `${root}.worktrees`,
                  worktreeSetup: WorktreeSetup.cases.Command.make({
                    command: "mkdir -p node_modules; printf setup-ready",
                  }),
                  hidden: false,
                  registeredAt: at,
                }),
              }),
              ...decideSession(undefined, { type: "session.fork", session: lead }).events,
              DomainEvent.cases.ConstellationStarted.make({
                constellationId: CID,
                revision: 0,
                constellation: new Constellation({
                  id: CID,
                  hostId: HOST,
                  workspaceId: WS,
                  leadSessionId: LEAD,
                  name: "Build",
                  state: "running",
                  revision: 0,
                  settings: ConstellationSettings.make({}),
                  tasks: [new Task({ ...taskData(task()), revision: 0, canceled: false })],
                  attempts: [],
                  pendingNotifications: [],
                  createdAt: at,
                  updatedAt: at,
                }),
              }),
            ]),
        })
        .pipe(Effect.orDie);
    })
  ).pipe(Layer.provideMerge(attachments));

  const engine = Engine.layer.pipe(Layer.provideMerge(seeded));

  const layer = constellationServices.pipe(
    Layer.provideMerge(trustedSetup),
    Layer.provideMerge(engine)
  );

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const graphs = yield* Constellations;
          const store = yield* EventStore;
          const engine = yield* Engine;

          const configure = (command: string, id: string) =>
            engine.dispatch({
              commandId: CommandId.make(id),
              deviceLabel: "test",
              command: Command.cases.SetWorktreeSetup.make({
                workspaceId: WS,
                setup: WorktreeSetup.cases.Command.make({ command }),
              }),
            });

          yield* configure("printf setup-broken >&2; exit 7", "bad-setup");

          const rejected = yield* graphs
            .command(
              { kind: "user" },
              CommandId.make("dispatch-real"),
              C.Dispatch.make({
                constellationId: CID,
                tasks: [
                  { taskId: task().id, worker: WorkerPlacement.cases.New.make({ hostId: HOST }) },
                ],
              })
            )
            .pipe(Effect.flip);

          expect(rejected.findings[0]?.code).toBe("E-SETUP");
          const failedModel = yield* store.model;
          expect(failedModel.constellations.get(CID)!.graph.revision).toBe(0);
          expect(failedModel.constellations.get(CID)!.graph.attempts).toHaveLength(0);

          const failedSession = [...failedModel.sessions.values()].find(
            (s) => s.session.id !== LEAD
          )!;

          expect(failedSession.session.state).toBe("failed");
          expect(failedSession.session.worktreeSetup?.output).toBe("setup-broken");
          expect(failedSession.turns).toHaveLength(0);
          expect(holds).toBe(0);
          expect(driver.sessions).toHaveLength(0);
          yield* configure("mkdir -p node_modules; printf setup-ready", "repair-setup");
          yield* graphs.command(
            { kind: "user" },
            CommandId.make("dispatch-real"),
            C.Dispatch.make({
              constellationId: CID,
              tasks: [
                { taskId: task().id, worker: WorkerPlacement.cases.New.make({ hostId: HOST }) },
              ],
            })
          );
          const attempt = (yield* store.model).constellations.get(CID)!.graph.attempts[0]!;

          const prepared = (yield* store.model).sessions.get(attempt.sessionId)!.session
            .worktreeSetup;

          expect(prepared?.status).toBe("completed");
          expect(prepared?.output).toBe("setup-ready");
          expect(Date.parse(prepared!.endedAt!)).toBeLessThanOrEqual(Date.parse(attempt.startedAt));
          // A new worker Session is marked, so session lists and pushes leave it to its Lead.
          expect((yield* store.model).sessions.get(attempt.sessionId)!.session.worker).toEqual({
            constellationId: CID,
          });
          expect(holds).toBe(0);

          expect(driver.sessions).toHaveLength(0);
          expect((yield* store.model).sessions.get(attempt.sessionId)!.turns).toHaveLength(0);
          yield* Latch.open(gate);
          yield* waitUntil(
            () => driver.sessions.length === 1 && driver.sessions[0]!.turns.length === 1
          );
          expect(holds).toBe(1);
          const harness = driver.sessions[0]!;
          expect(harness.options.environment?.POLARIS_SESSION_ID).toBe(attempt.sessionId);
          expect(harness.options.constellations).toHaveLength(1);
          expect(harness.options.constellations![0]!.instructions).toContain("claim");
          expect(harness.turns[0]!.prompt).toContain("Build A");
          const liveness = yield* ConstellationLiveness;
          const live = yield* liveness.subscribe(CID);

          const update = yield* live.pipe(
            Stream.filter((event) => event.liveness.contextPercent === 50),
            Stream.take(1),
            Stream.runHead,
            Effect.forkChild
          );

          harness.emit(HarnessEvent.ContextUsed({ usedTokens: 50, windowTokens: 100 }));
          yield* waitFor(
            (m) => m.sessions.get(attempt.sessionId)?.session.contextUsage?.usedTokens === 50
          );
          const event = Option.getOrThrow(yield* Fiber.join(update));
          expect(event.liveness.contextPercent).toBe(50);
          const facts = yield* liveness.read((yield* store.model).constellations.get(CID)!);
          expect(facts.get(attempt.id)?.contextPercent).toBe(50);
          const tool = harness.options.constellations![0]!.tools.find((t) => t.name === "status")!;
          const result = yield* Effect.promise(() => tool.call({}));
          expect(result.isError).not.toBe(true);
          harness.emit(
            HarnessEvent.ItemCompleted({
              turnId: harness.turns[0]!.turnId,
              item: TurnItem.cases.AssistantMessage.make({ id: "answer", text: "still working" }),
            })
          );
          yield* exerciseHandover(driver);
          initialOpens = driver.sessions.length;
          yield* (yield* Engine).prepareForUpgrade;
          const recovered = (yield* store.model).constellations.get(CID)!;
          // A live co-attach setting is false in this fake, so upgrade records proof before the Harness is stopped.
          expect(recovered.interruptions.get(attempt.id)?.eligible).toBe(true);
        })
      ).pipe(Effect.provide(layer))
    );
    expect(holds).toBe(0);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* waitUntil(
            () =>
              driver.sessions.length === initialOpens + 1 &&
              driver.sessions.at(-1)!.turns.length === 1
          );
          expect(holds).toBe(1);
          expect(driver.sessions.at(-1)!.turns[0]!.prompt).toBe(
            "The Daemon restarted; continue your Task"
          );
          expect((yield* store.model).constellations.get(CID)!.recoveries.size).toBe(1);
        })
      ).pipe(Effect.provide(layer))
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;
          expect((yield* store.model).constellations.get(CID)!.recoveries.size).toBe(1);
          expect(driver.sessions).toHaveLength(initialOpens + 1);
          expect(
            [...(yield* store.model).sessions.values()].some((r) => r.session.state === "needs-you")
          ).toBe(true);
        })
      ).pipe(Effect.provide(layer))
    );
  } finally {
    removeTempDir(root);
  }
});

const exerciseHandover = Effect.fnUntraced(function* (driver: FakeDriver) {
  const graphs = yield* Constellations;
  const store = yield* EventStore;
  const tokens = yield* McpTokens;
  yield* graphs.command(
    { kind: "user" },
    CommandId.make("gate-plan"),
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Add.make({ task: task(G, [], "gate") })],
    })
  );
  yield* graphs.command(
    { kind: "user" },
    CommandId.make("gate-start"),
    C.Dispatch.make({
      constellationId: CID,
      tasks: [{ taskId: G, worker: WorkerPlacement.cases.Existing.make({ sessionId: LEAD }) }],
    })
  );
  yield* waitUntil(() => driver.latest(LEAD)?.turns.length === 1);
  const attachments = driver.latest(LEAD)!.options.constellations!;
  expect(attachments).toHaveLength(2);
  const oldTokens = attachments.map((a) => new URL(a.url).pathname.split("/").at(-1)!);

  for (const token of oldTokens) expect(yield* tokens.authenticate(token)).not.toBeNull();
  const worker = driver.sessions[0]!.options.constellations![0]!;
  const workerToken = new URL(worker.url).pathname.split("/").at(-1)!;
  yield* graphs.command(
    { kind: "session", sessionId: LEAD },
    CommandId.make("handover-real"),
    C.SetState.make({
      constellationId: CID,
      action: SetConstellationStateAction.cases.HandOver.make({ summary: "", interrupt: false }),
    })
  );
  yield* waitFor((m) => m.constellations.get(CID)!.graph.leadSessionId !== LEAD);
  const graph = (yield* store.model).constellations.get(CID)!.graph;
  expect(graph.attempts.find((a) => a.taskId === G)!.state).toBe("lost");
  expect(graph.attempts[0]!.state).toBe("working");
  expect((yield* store.model).sessions.get(graph.leadSessionId)!.turns[0]!.prompt).toContain(
    "Gate G was in progress at handover: re-run it"
  );

  for (const token of oldTokens) expect(yield* tokens.authenticate(token)).toBeNull();
  expect(yield* tokens.authenticate(workerToken)).not.toBeNull();
  yield* waitUntil(() => driver.latest(graph.leadSessionId)?.turns.length === 1);
});
