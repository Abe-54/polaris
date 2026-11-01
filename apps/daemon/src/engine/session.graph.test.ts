/**
 * Model-based tests generated from the session machine: `xstate/graph` walks
 * the test model (session.testing.ts) and every path it finds is replayed
 * against the real Engine with the fake Harness. After every step the Engine's
 * observed session (Session State, Turn in flight, last Turn status, pending
 * approvals, whether a Harness runs) must equal the model's; at the end of
 * each path, every command the machine refuses there must be refused by the
 * Engine with the same reason.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ApprovalDecision,
  Command,
  CommandRejected,
  RequestId,
  SessionId,
  TurnTrigger,
  SessionPlacement,
  TurnId,
  type WorkspaceId,
} from "@polaris/protocol";
import { type Context, Effect, Exit, Layer, Scope } from "effect";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { EventStore } from "../store/EventStore.ts";
import { workingTurn } from "../store/model.ts";
import { decideSession } from "./session.ts";
import { Engine } from "./Engine.ts";
import {
  attachRequest,
  COMMAND_STEPS,
  channelOf,
  initialSnapshot,
  type ModelOptions,
  type ModelSnapshot,
  type Observed,
  observe,
  observeModel,
  pathsFor,
  BACKGROUND_COMMAND,
  RESETS_AT,
  SESSION,
  type Step,
  stepModel,
} from "./session.testing.ts";
import { cid, engineLayer, makeFakeDriver, makeFakes, tempDir } from "./testing.ts";

const PARENT = SessionId.make("s-parent");

type Env = Engine | EventStore;

/** Replays `steps` against a fresh Engine, checking it against the model after each. */
const replay = (options: ModelOptions, steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const driver = makeFakeDriver(options.harness, {
      liveCoAttach: options.liveCoAttach,
      switchModel: options.switchModel,
      follow: !options.liveCoAttach,
    });

    const layer = engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [driver],
    });

    let scope = yield* Scope.make();
    let services: Context.Context<Env> = yield* Layer.buildWithScope(layer, scope);
    const inEngine = <A, E>(effect: Effect.Effect<A, E, Env>) => Effect.provide(effect, services);

    const dispatch = (command: Command) =>
      inEngine(
        Effect.flatMap(Engine, (engine) =>
          engine.dispatch({ commandId: cid("model"), command, deviceLabel: "model" })
        )
      );

    const record = () =>
      inEngine(Effect.map(EventStore, (store) => store)).pipe(
        Effect.flatMap((store) => store.model),
        Effect.map((model) => model.sessions.get(SESSION))
      );

    const harnessLive = (sessionId = SESSION) => {
      const latest = driver.latest(sessionId);

      return latest !== undefined && !latest.closed;
    };

    const observed = () => Effect.map(record(), (r) => observe(r, harnessLive()));

    /** Wait for the Engine to show `expected` (its reactors run after the ack). */
    const settle = (expected: Observed, done: ReadonlyArray<Step>) =>
      Effect.gen(function* () {
        const deadline = Date.now() + 3000;

        while (true) {
          const actual = yield* observed();

          if (Bun.deepEquals(actual, expected)) return;

          if (Date.now() > deadline) {
            return yield* Effect.die(
              new Error(
                `after ${done.map((s) => s.type).join(" → ")}: the Engine shows ${JSON.stringify(actual)}, the machine ${JSON.stringify(expected)}`
              )
            );
          }

          yield* Effect.sleep(2);
        }
      });

    // A Workspace (not a git repository: no checkpoints or Worktrees to fake).
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: tempDir(), name: null }));

    const workspaceId: WorkspaceId = yield* inEngine(
      Effect.flatMap(EventStore, (store) => store.model)
    ).pipe(Effect.map((model) => [...model.workspaces.keys()][0]!));

    const start = (sessionId: SessionId) =>
      dispatch(
        Command.cases.StartSession.make({
          sessionId,
          workspaceId,
          harness: options.harness,
          placement: SessionPlacement.cases.InPlace.make({}),
          permissionMode: "supervised",
          model: null,
          effort: null,
          prompt: "model",
          attachments: [],
        })
      );

    const emit = (snapshot: ModelSnapshot, ...events: ReadonlyArray<HarnessEvent>) => {
      const channel = channelOf(snapshot, options);

      if (channel === "harness") driver.latest(SESSION)!.emit(...events);
      else if (channel === "follower") driver.follow.emit(SESSION, ...events);
      else throw new Error("no channel to the Harness");
    };

    const working = () =>
      Effect.map(record(), (r) => {
        const turn = r && workingTurn(r);

        if (turn === undefined) throw new Error("no Turn in flight");

        return turn.id;
      });

    const firstPending = () =>
      Effect.map(record(), (r) => [...(r?.pending.keys() ?? [])][0] ?? RequestId.make("none"));

    const drive = (snapshot: ModelSnapshot, step: Step) =>
      Effect.gen(function* () {
        const n = snapshot.counter;

        switch (step.type) {
          case "start":
            return yield* start(SESSION);
          case "fork": {
            yield* start(PARENT);
            yield* Effect.gen(function* () {
              while (!harnessLive(PARENT)) yield* Effect.sleep(2);
            });

            const parent = yield* inEngine(Effect.flatMap(EventStore, (store) => store.model)).pipe(
              Effect.map((model) => model.sessions.get(PARENT)!)
            );

            const turnId = workingTurn(parent)!.id;
            driver
              .latest(PARENT)!
              .emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
            yield* Effect.gen(function* () {
              while (true) {
                const model = yield* inEngine(Effect.flatMap(EventStore, (store) => store.model));

                if (model.sessions.get(PARENT)?.session.state === "idle") return;
                yield* Effect.sleep(2);
              }
            });

            return yield* dispatch(
              Command.cases.ForkSession.make({
                sessionId: SESSION,
                fromSessionId: PARENT,
                fromTurnId: turnId,
                harness: options.harness,
                model: null,
                effort: null,
              })
            );
          }

          case "send":
            return yield* dispatch(
              Command.cases.SendTurn.make({ sessionId: SESSION, prompt: "model", attachments: [] })
            );
          case "continue":
            return yield* dispatch(Command.cases.Continue.make({ sessionId: SESSION }));
          case "retry":
            return yield* dispatch(Command.cases.Retry.make({ sessionId: SESSION }));
          case "interrupt": {
            yield* dispatch(Command.cases.Interrupt.make({ sessionId: SESSION }));

            // The fake Harness answers an interrupt by ending the Turn.
            if (snapshot.live) {
              const turnId = yield* working();
              emit(
                snapshot,
                HarnessEvent.TurnEnded({ turnId, status: "interrupted", error: null })
              );
            }

            return;
          }

          case "stopBackground": {
            yield* dispatch(
              Command.cases.StopBackgroundTasks.make({ sessionId: SESSION, taskIds: null })
            );

            // The fake Harness stops them and reports none left.
            if (snapshot.live) emit(snapshot, HarnessEvent.BackgroundTasksChanged({ tasks: [] }));

            return;
          }

          case "approve":
            return yield* dispatch(
              Command.cases.RespondToApproval.make({
                sessionId: SESSION,
                requestId: yield* firstPending(),
                decision: ApprovalDecision.cases.Allow.make({ remember: false }),
              })
            );
          case "archive":
            return yield* dispatch(
              Command.cases.ArchiveSession.make({ sessionId: SESSION, deleteMergedBranch: false })
            );
          case "unarchive":
            return yield* dispatch(Command.cases.UnarchiveSession.make({ sessionId: SESSION }));
          case "openTerminal":
            return yield* dispatch(Command.cases.OpenInTerminal.make({ sessionId: SESSION }));
          case "returnTerminal":
            return yield* dispatch(Command.cases.ReturnFromTerminal.make({ sessionId: SESSION }));
          case "setModel":
            return yield* dispatch(
              Command.cases.SetModel.make({ sessionId: SESSION, model: `m${n}`, effort: null })
            );
          case "requestAttach": {
            const request = attachRequest(`r${n}`, yield* working());

            return yield* inEngine(
              Effect.flatMap(EventStore, (store) =>
                store.commit({
                  commandId: null,
                  decide: (model) =>
                    Effect.succeed(
                      decideSession(model.sessions.get(SESSION), {
                        type: "inspector.approvalRequested",
                        request,
                      }).events
                    ),
                })
              )
            );
          }

          case "requestApproval":
            return emit(
              snapshot,
              HarnessEvent.ApprovalRequested({
                turnId: yield* working(),
                requestId: RequestId.make(`r${n}`),
                kind: "command",
                title: "model",
                detail: null,
                options: [],
              })
            );
          case "lateApproval":
            return emit(
              snapshot,
              HarnessEvent.ApprovalRequested({
                turnId: yield* inEngine(Effect.flatMap(EventStore, (store) => store.model)).pipe(
                  Effect.map(
                    (model) =>
                      model.sessions.get(SESSION)!.turns.findLast((t) => t.status !== "working")!.id
                  )
                ),
                requestId: RequestId.make(`r${n}`),
                kind: "command",
                title: "late",
                detail: null,
                options: [],
              })
            );
          case "withdrawApproval":
            return emit(
              snapshot,
              HarnessEvent.ApprovalWithdrawn({ requestId: yield* firstPending() })
            );
          case "terminalTurn":
            return emit(
              snapshot,
              HarnessEvent.TurnStarted({ turnId: TurnId.make(`tui${n}`), prompt: "tui" })
            );
          case "backgroundTurn":
            return emit(
              snapshot,
              HarnessEvent.TurnStarted({
                turnId: TurnId.make(`auto${n}`),
                prompt: null,
                trigger: TurnTrigger.cases.BackgroundTasksReported.make({
                  tasks: [{ id: "sub1", kind: "subagent" }],
                }),
              })
            );
          case "reportBackground":
            return emit(
              snapshot,
              HarnessEvent.BackgroundTasksChanged({ tasks: [BACKGROUND_COMMAND] })
            );
          case "complete":
          case "failTurn":
            return emit(
              snapshot,
              HarnessEvent.TurnEnded({
                turnId: yield* working(),
                status: step.type === "complete" ? "completed" : "failed",
                error: step.type === "complete" ? null : "the Turn failed",
              })
            );
          case "limitTurn":
            return emit(
              snapshot,
              HarnessEvent.TurnEnded({
                turnId: yield* working(),
                status: "failed",
                error: "usage limit",
                limit: { resetsAt: RESETS_AT },
              })
            );
          case "exit":
          case "crash":
            return driver
              .latest(SESSION)!
              .emit(HarnessEvent.Exited({ error: step.type === "exit" ? null : "boom" }));
          case "restart":
            yield* Scope.close(scope, Exit.void);
            scope = yield* Scope.make();
            services = yield* Layer.buildWithScope(layer, scope);

            return;
        }
      });

    let snapshot = initialSnapshot();
    const done: Array<Step> = [];

    for (const step of steps) {
      const { next, rejection } = stepModel(snapshot, step, options);
      expect(rejection).toBeNull();
      yield* drive(snapshot, step);
      done.push(step);
      snapshot = next;
      yield* settle(observeModel(snapshot), done);
    }

    // Every command the machine refuses here, the Engine refuses, for the same reason.
    let refused = 0;

    for (const type of COMMAND_STEPS) {
      const { rejection } = stepModel(snapshot, { type }, options);

      if (rejection === null) continue;
      const result = yield* drive(snapshot, { type }).pipe(Effect.flip);
      expect(result).toBeInstanceOf(CommandRejected);
      expect(result instanceof CommandRejected ? result.reason : null).toBe(rejection);
      refused++;
    }

    yield* settle(observeModel(snapshot), done);

    // A late approval request (for a Turn that ended) changes nothing, in the model and the Engine.
    const late = stepModel(snapshot, { type: "lateApproval" }, options);

    if (late.next !== snapshot) {
      expect(observeModel(late.next)).toEqual(observeModel(snapshot));
      yield* drive(snapshot, { type: "lateApproval" });
      yield* Effect.sleep(5);
      yield* settle(observeModel(late.next), [...done, { type: "lateApproval" }]);
    }

    yield* Scope.close(scope, Exit.void);

    return refused;
  });

const suites: ReadonlyArray<ModelOptions> = [
  { harness: "claude", liveCoAttach: false, switchModel: true },
  { harness: "codex", liveCoAttach: true, switchModel: true },
];

for (const options of suites) {
  const paths = pathsFor(options);
  const handOff = options.liveCoAttach ? "live co-attach" : "sequential hand-off";
  describe(`session machine vs Engine: ${options.harness} (${handOff})`, () => {
    test(`${paths.states.length} shortest paths, one to every state`, async () => {
      let refused = 0;

      for (const steps of paths.states) {
        refused += await Effect.runPromise(replay(options, steps));
      }

      expect(refused).toBeGreaterThan(0);
    }, 120_000);

    test(`${paths.transitions.length} transition paths, one per state-changing transition`, async () => {
      const queue = [...paths.transitions];
      // A few Engines at a time: each is its own SQLite file and fake Harness.
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (queue.length > 0) {
            const steps = queue.shift()!;
            await Effect.runPromise(replay(options, steps));
          }
        })
      );
    }, 300_000);
  });
}

test("inspector approval preserves terminal control through Allow and return", async () => {
  await Effect.runPromise(
    replay({ harness: "codex", liveCoAttach: true, switchModel: true }, [
      { type: "start" },
      { type: "complete" },
      { type: "openTerminal" },
      { type: "terminalTurn" },
      { type: "requestAttach" },
      { type: "approve" },
      { type: "returnTerminal" },
    ])
  );
}, 30000);
