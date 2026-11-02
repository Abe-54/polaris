import { expect } from "bun:test";
import {
  AgentSession,
  CommandId,
  ConstellationSettings,
  DomainEvent,
  type HarnessKind,
  PlanOperation,
  SessionId,
  type Turn,
  WorkerPlacement,
  Workspace,
} from "@polaris/protocol";
import { Effect, Layer, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { A, AT, C, CID, HOST, LEAD, WS, draft, task } from "../../engine/constellation.testing.ts";
import { decideSession, type SessionInput } from "../../engine/session.ts";
import { registerWorkerAdmission } from "../../resources/workerAdmission.ts";
import { EventStore } from "../../store/EventStore.ts";
import { Constellations } from "../service.ts";
import { ConstellationOwner } from "../runtime.ts";
import { withHandoverPreparation } from "../handover/index.ts";
import { ConstellationRuntime } from "../runtime.ts";
import {
  ConstellationDelivery,
  ConstellationSessionEffects,
  ConstellationRemoteDelivery,
  type DeliveryPacket,
} from "./index.ts";
import { WorktreeSetupService } from "../setup/index.ts";
import { newTurn } from "./turns.ts";
import { trustedSetup } from "../setup/trust.testing.ts";

export const WORKER = SessionId.make("worker");

export const STANDALONE = SessionId.make("standalone");

export const session = (id: SessionId, harness: HarnessKind = "codex") =>
  new AgentSession({
    id,
    workspaceId: WS,
    harness,
    title: id,
    cwd: "/tmp",
    worktreeId: null,
    state: "idle",
    permissionMode: "supervised",
    model: "gpt-6.1-sol",
    effort: "high",
    parentSessionId: null,
    forkedFromTurnId: null,
    harnessCursor: null,
    turnCount: 0,
    contextUsage: null,
    lastError: null,
    createdAt: AT,
    updatedAt: AT,
  });

export const signal = Effect.fnUntraced(function* (id: SessionId, input: SessionInput) {
  const store = yield* EventStore;

  return yield* store.commit({
    commandId: null,
    decide: (model) => {
      const decision = decideSession(model.sessions.get(id), input);
      expect(decision.rejection).toBeNull();

      return Effect.succeed(decision.events);
    },
  });
});

export const send = Effect.fnUntraced(function* (id: SessionId, text: string = "Work") {
  const store = yield* EventStore;
  const record = (yield* store.model).sessions.get(id)!;

  return yield* signal(id, {
    type: "turn.send",
    turn: newTurn(record.session, text, new Date().toISOString()),
  });
});

export const finish = Effect.fnUntraced(function* (
  id: SessionId,
  status: "completed" | "interrupted" | "failed" = "completed",
  at: string = AT
) {
  const store = yield* EventStore;
  const turn = (yield* store.model).sessions.get(id)?.turns.find((t) => t.status === "working");

  if (turn === undefined) throw new Error("no working Turn");
  yield* signal(id, { type: "harness.opened" });
  yield* signal(id, {
    type: "harness.turnEnded",
    turnId: turn.id,
    status,
    at,
    checkpoint: null,
    error: status === "failed" ? "Harness failed" : null,
  });
});

export const wait = Effect.fnUntraced(function* (predicate: () => Effect.Effect<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (yield* predicate()) return;
    yield* Effect.promise(() => Bun.sleep(5));
  }

  throw new Error("delivery did not settle");
});

export const setup = Effect.fnUntraced(function* (
  settings: ConstellationSettings = ConstellationSettings.make({}),
  workerHarness: HarnessKind = "codex"
) {
  const store = yield* EventStore;
  yield* store.commit({
    commandId: null,
    decide: () =>
      Effect.succeed([
        DomainEvent.cases.WorkspaceRegistered.make({
          workspace: new Workspace({
            id: WS,
            path: "/tmp",
            name: "test",
            isGitRepo: true,
            worktreeRoot: "/tmp/trees",
            hidden: false,
            registeredAt: AT,
          }),
        }),
        ...[LEAD, WORKER, STANDALONE].map((id) =>
          DomainEvent.cases.SessionCreated.make({
            session: session(id, id === WORKER ? workerHarness : "codex"),
          })
        ),
      ]),
  });
  const graphs = yield* Constellations;
  yield* graphs.command(
    { kind: "user" },
    CommandId.make("plan"),
    C.Plan.make({
      constellationId: CID,
      start: { workspaceId: WS, name: "Build", leadSessionId: LEAD, settings },
      operations: [PlanOperation.cases.Add.make({ task: task() })],
    })
  );
  yield* graphs.command(
    { kind: "user" },
    CommandId.make("dispatch"),
    C.Dispatch.make({
      constellationId: CID,
      tasks: [{ taskId: A, worker: WorkerPlacement.cases.Existing.make({ sessionId: WORKER }) }],
    })
  );
});

/** Relay fixtures have fake Turn runners and no resource pool; mount explicit no-op admission. */
export const fakeWorkerAdmission = Effect.fnUntraced(function* (
  store: EventStore["Service"],
  id: SessionId
) {
  yield* registerWorkerAdmission(
    store,
    id,
    yield* Effect.scope,
    Effect.void,
    Effect.succeed(false)
  );
});

export const world = (
  file = ":memory:",
  options: {
    readonly canSteer?: boolean;
    readonly onRun?: (turn: Turn) => Effect.Effect<void, never, EventStore>;
    readonly attempt?: ReturnType<typeof draft>;
    readonly remoteSend?: (packet: DeliveryPacket) => Effect.Effect<void>;
    readonly runtime?: Layer.Layer<
      never,
      never,
      EventStore | ConstellationSessionEffects | WorktreeSetupService
    >;
  } = {}
) => {
  const turns: Turn[] = [];
  const prompts: string[] = [];
  const steers: string[] = [];
  const retired: SessionId[] = [];

  const effects = Layer.effect(
    ConstellationSessionEffects,
    Effect.gen(function* () {
      const store = yield* EventStore;

      return {
        runTurn: (turn: Turn, prompt: string) =>
          Effect.gen(function* () {
            turns.push(turn);
            prompts.push(prompt);
            yield* signal(turn.sessionId, { type: "harness.opened" }).pipe(
              Effect.provideService(EventStore, store),
              Effect.orDie
            );

            if (options.onRun !== undefined)
              yield* options.onRun(turn).pipe(Effect.provideService(EventStore, store));
          }),
        canSteer: () => Effect.succeed(options.canSteer ?? true),
        steer: (_id: SessionId, text: string) =>
          Effect.sync(() => {
            steers.push(text);
          }),
        interrupt: (id: SessionId) =>
          finish(id, "interrupted").pipe(Effect.provideService(EventStore, store), Effect.orDie),
        retire: (id: SessionId) =>
          Effect.sync(() => {
            retired.push(id);
          }),
      };
    })
  ).pipe(Layer.provideMerge(EventStore.layerSqlite(file)));

  const runtime = withHandoverPreparation({
    prepare: () =>
      Effect.succeed({
        attempts: [options.attempt ?? draft()],
        newLeadSessionId: null,
        claimProbe: { dirtyPaths: [], branch: "polaris/A", head: "head" },
        recordedChecks: [],
      }),
    resumeWorking: () => Effect.void,
    afterCommit: () => Effect.void,
  });

  const configured = WorktreeSetupService.layer.pipe(
    Layer.provide(trustedSetup),
    Layer.provideMerge(effects)
  );

  const layer = Layer.mergeAll(Constellations.layer, ConstellationDelivery.layer).pipe(
    Layer.provideMerge(
      (options.runtime ?? Layer.succeed(ConstellationRuntime)(runtime)).pipe(
        Layer.provide(configured)
      )
    ),
    Layer.provideMerge(configured),
    Layer.provide(Layer.succeed(ConstellationOwner)(HOST)),
    Layer.provide(
      Layer.succeed(ConstellationRemoteDelivery)({
        send: options.remoteSend ?? (() => Effect.never),
      })
    )
  );

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Scope.Scope
      | Constellations
      | ConstellationDelivery
      | EventStore
      | ConstellationSessionEffects
      | WorktreeSetupService
    >
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.provide(TestClock.layer({ warningDelay: "1 hour" }))
      )
    );

  return { run, turns, prompts, steers, retired, runtime };
};
