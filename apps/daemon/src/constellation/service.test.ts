import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AgentSession,
  CommandId,
  ConstellationQuestion,
  DomainEvent,
  PlanOperation,
  ReviewAction,
  SessionId,
  Turn,
  TurnId,
  TurnItem,
  ToolCallReference,
  CheckReceipt,
  Workspace,
} from "@polaris/protocol";
import { Effect, Fiber, Layer, Predicate, Stream } from "effect";
import {
  A,
  AT,
  C,
  CID,
  HOST,
  LEAD,
  WS,
  draft,
  report,
  task,
} from "../engine/constellation.testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { Constellations } from "./service.ts";
import { ConstellationOwner, ConstellationRuntime } from "./runtime.ts";
import { ConstellationSettings } from "@polaris/protocol";
import { ConstellationDefaultsPath, setDefaults } from "./defaults.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const user = { kind: "user" as const };

const workerId = SessionId.make("worker");

const commandId = (id: string) => CommandId.make(id);

const session = (id: SessionId) =>
  new AgentSession({
    id,
    workspaceId: WS,
    harness: "codex",
    title: id,
    cwd: "/tmp",
    worktreeId: null,
    state: "idle",
    permissionMode: "supervised",
    model: null,
    effort: null,
    parentSessionId: null,
    forkedFromTurnId: null,
    harnessCursor: null,
    turnCount: 0,
    contextUsage: null,
    lastError: null,
    createdAt: AT,
    updatedAt: AT,
  });

const seed = Effect.gen(function* () {
  const store = yield* EventStore;
  yield* store.commit({
    commandId: commandId("seed"),
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
        DomainEvent.cases.SessionCreated.make({ session: session(LEAD) }),
        DomainEvent.cases.SessionCreated.make({ session: session(workerId) }),
      ]),
  });
});

const start = C.Plan.make({
  constellationId: CID,
  start: {
    name: "Build",
    workspaceId: WS,
    leadSessionId: LEAD,
    settings: new ConstellationSettings({}),
  },
  operations: [PlanOperation.cases.Add.make({ task: task() })],
});

const layer = (file: string) =>
  Constellations.layer.pipe(
    Layer.provideMerge(EventStore.layerSqlite(file)),
    Layer.provide(Layer.succeed(ConstellationOwner)(HOST)),
    Layer.provide(
      Layer.succeed(ConstellationRuntime)({
        prepare: () =>
          Effect.succeed({
            attempts: [draft()],
            newLeadSessionId: null,
            claimProbe: { dirtyPaths: [], branch: "polaris/A", head: "head" },
            recordedChecks: [],
          }),
        afterCommit: () => Effect.void,
        resumeWorking: () => Effect.void,
      })
    )
  );

const run = <A, E>(file: string, effect: Effect.Effect<A, E, EventStore | Constellations>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer(file))));

describe("Constellation store and service", () => {
  test("plan.start snapshots omitted Host defaults without changing existing graphs", async () => {
    const dir = newTempDir("c1-default-plan-");

    try {
      await run(
        join(dir, "state.sqlite"),
        Effect.gen(function* () {
          yield* seed;
          yield* setDefaults(ConstellationSettings.make({ branchPrefix: "team" }));
          const graphs = yield* Constellations;

          const result = yield* graphs.command(
            user,
            commandId("default-plan"),
            C.Plan.make({
              constellationId: CID,
              start: { name: "defaults", workspaceId: WS, leadSessionId: LEAD },
              operations: [],
            })
          );

          expect(result.constellation?.settings.branchPrefix).toBe("team");
          yield* setDefaults(ConstellationSettings.make({ branchPrefix: "changed" }));
          expect((yield* graphs.status(user, CID, true)).constellation?.settings.branchPrefix).toBe(
            "team"
          );
        }).pipe(Effect.provideService(ConstellationDefaultsPath, join(dir, "settings.json")))
      );
    } finally {
      removeTempDir(dir);
    }
  });
  test("restart re-folds graph, questions and messages; rejected command receipts retain findings", async () => {
    const dir = newTempDir("c1-e-store-");
    const file = join(dir, "state.sqlite");

    try {
      const before = await run(
        file,
        Effect.gen(function* () {
          yield* seed;
          const graphs = yield* Constellations;
          yield* graphs.command(user, commandId("plan"), start);
          const duplicate = yield* graphs.command(user, commandId("plan"), start);
          expect(duplicate.constellation?.tasks).toHaveLength(1);
          yield* graphs.command(
            user,
            commandId("dispatch"),
            C.Dispatch.make({ constellationId: CID })
          );
          const attemptId = draft().id;
          yield* graphs.command(
            { kind: "session", sessionId: workerId },
            commandId("ask"),
            C.WorkerAsk.make({
              constellationId: CID,
              attemptId,
              question: new ConstellationQuestion({
                id: "q",
                to: "user",
                text: "Which base?",
                blocking: true,
              }),
            })
          );

          const invalid = C.Review.make({
            constellationId: CID,
            attemptId,
            revision: 99,
            action: ReviewAction.cases.Stop.make({ reason: "stop" }),
          });

          const refused = yield* graphs
            .command(user, commandId("bad-revision"), invalid)
            .pipe(Effect.catchTag("ConstellationRejected", (error) => Effect.succeed(error)));

          expect(Predicate.isTagged(refused, "ConstellationRejected")).toBe(true);
          const store = yield* EventStore;

          return (yield* store.model).constellations.get(CID)!;
        })
      );

      await run(
        file,
        Effect.gen(function* () {
          const store = yield* EventStore;
          const loaded = (yield* store.model).constellations.get(CID)!;
          expect(loaded).toEqual(before);
          const graphs = yield* Constellations;

          const replayed = yield* graphs
            .command(
              user,
              commandId("bad-revision"),
              C.Plan.make({ constellationId: CID, operations: [] })
            )
            .pipe(Effect.catchTag("ConstellationRejected", (error) => Effect.succeed(error)));

          expect(
            Predicate.isTagged(replayed, "ConstellationRejected")
              ? replayed.findings[0]?.code
              : "accepted"
          ).toBe("E-REVISION");
        })
      );
    } finally {
      removeTempDir(dir);
    }
  });
  test("concurrent edits at one Task revision: exactly one commits and the other is rejected", async () => {
    await run(
      ":memory:",
      Effect.gen(function* () {
        yield* seed;
        const graphs = yield* Constellations;
        yield* graphs.command(user, commandId("plan"), start);

        const edit = C.Plan.make({
          constellationId: CID,
          operations: [PlanOperation.cases.Edit.make({ taskId: A, revision: 0, task: task() })],
        });

        const verdicts = yield* Effect.all(
          ["edit-a", "edit-b"].map((id) =>
            graphs.command(user, commandId(id), edit).pipe(
              Effect.as("accepted"),
              Effect.catchTag("ConstellationRejected", () => Effect.succeed("rejected"))
            )
          ),
          { concurrency: "unbounded" }
        );

        expect(verdicts.sort()).toEqual(["accepted", "rejected"]);
        const store = yield* EventStore;

        const rows = yield* store.readConstellationEvents({
          constellationId: CID,
          after: 0,
          upTo: (yield* store.model).sequence,
        });

        expect(rows.filter((e) => Predicate.isTagged(e.event, "TaskEdited"))).toHaveLength(1);
      })
    );
  });
  test("stream sends snapshot, cut and live events; resuming from the snapshot replays the later event, then the cut", async () => {
    await run(
      ":memory:",
      Effect.gen(function* () {
        yield* seed;
        const graphs = yield* Constellations;
        yield* graphs.command(user, commandId("plan"), start);
        const store = yield* EventStore;

        const fiber = yield* graphs
          .subscribe(user, CID, null)
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

        while ((yield* store.subscriberCount) === 0) yield* Effect.sleep(1);
        yield* graphs.command(
          user,
          commandId("edit"),
          C.Plan.make({
            constellationId: CID,
            operations: [PlanOperation.cases.Edit.make({ taskId: A, revision: 0, task: task() })],
          })
        );
        const items = yield* Fiber.join(fiber);
        expect(items.map((item) => item._tag)).toEqual(["Snapshot", "Synchronized", "Event"]);
        const first = items[0]!;

        if (!Predicate.isTagged(first, "Snapshot")) throw new Error("expected snapshot");

        const replay = yield* graphs
          .subscribe(user, CID, first.sequence)
          .pipe(Stream.take(2), Stream.runCollect);

        expect(replay.map((item) => item._tag)).toEqual(["Event", "Synchronized"]);
      })
    );
  });
  test("accept resolves a receipt from any local session's persisted command item", async () => {
    await run(
      ":memory:",
      Effect.gen(function* () {
        yield* seed;
        const graphs = yield* Constellations;
        yield* graphs.command(user, commandId("plan"), start);
        yield* graphs.command(
          user,
          commandId("dispatch"),
          C.Dispatch.make({ constellationId: CID })
        );
        yield* graphs.command(
          { kind: "session", sessionId: workerId },
          commandId("claim"),
          C.WorkerClaim.make({ constellationId: CID, attemptId: draft().id, claim: report() })
        );
        const store = yield* EventStore;
        const turnId = TurnId.make("check");
        yield* store.commit({
          commandId: commandId("check"),
          decide: () =>
            Effect.succeed([
              DomainEvent.cases.TurnStarted.make({
                turn: new Turn({
                  id: turnId,
                  sessionId: LEAD,
                  index: 0,
                  prompt: "check",
                  attachments: [],
                  model: null,
                  effort: null,
                  status: "working",
                  checkpointBefore: null,
                  checkpointAfter: null,
                  startedAt: AT,
                  endedAt: null,
                }),
              }),
              DomainEvent.cases.TurnItemCompleted.make({
                sessionId: LEAD,
                turnId,
                subagentId: null,
                item: TurnItem.cases.CommandExecution.make({
                  id: "check",
                  command: "bun test",
                  cwd: "/tmp",
                  output: "pass",
                  exitCode: 0,
                  status: "completed",
                }),
              }),
            ]),
        });

        const result = yield* graphs.command(
          user,
          commandId("accept"),
          C.Review.make({
            constellationId: CID,
            attemptId: draft().id,
            revision: 1,
            action: ReviewAction.cases.Accept.make({
              mergedHead: "head",
              receipts: [
                CheckReceipt.cases.Verified.make({
                  label: "tests",
                  item: new ToolCallReference({
                    hostId: HOST,
                    sessionId: LEAD,
                    turnId,
                    itemId: "check",
                  }),
                }),
              ],
            }),
          })
        );

        expect(result.constellation?.attempts[0]?.evidence).toBe("verified");
      })
    );
  });
});
