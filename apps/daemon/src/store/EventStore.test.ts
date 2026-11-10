import { tempDir } from "../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  AgentSession,
  CommandId,
  CommandRejected,
  DomainEvent,
  Sequence,
  SessionId,
  Turn,
  TurnId,
  TurnItem,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Exit, Fiber, Option, Predicate, Scheduler, Stream } from "effect";
import { CommitResult, EventStore } from "./EventStore.ts";
import { patchTurn } from "./model.ts";

const run = <A, E>(filename: string, program: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(EventStore.layerSqlite(filename))));

const at = "2026-09-28T00:00:00.000Z";

const wsId = WorkspaceId.make("ws-1");

const sId = SessionId.make("s-1");

const tId = TurnId.make("t-1");

const workspace = new Workspace({
  id: wsId,
  path: "/repo",
  name: "repo",
  isGitRepo: true,
  worktreeRoot: "/repo.worktrees",
  hidden: false,
  registeredAt: at,
});

/** `workspace` under another name. */
const workspaceNamed = (name: string) =>
  new Workspace({
    id: workspace.id,
    path: workspace.path,
    name,
    isGitRepo: workspace.isGitRepo,
    worktreeRoot: workspace.worktreeRoot,
    hidden: workspace.hidden,
    registeredAt: workspace.registeredAt,
  });

const session = new AgentSession({
  id: sId,
  workspaceId: wsId,
  harness: "claude",
  title: "t",
  cwd: "/repo",
  worktreeId: null,
  state: "starting",
  permissionMode: "supervised",
  model: null,
  effort: null,
  parentSessionId: null,
  forkedFromTurnId: null,
  harnessCursor: null,
  turnCount: 0,
  contextUsage: null,
  lastError: null,
  createdAt: at,
  updatedAt: at,
});

const turn = new Turn({
  id: tId,
  sessionId: sId,
  index: 0,
  prompt: "hi",
  attachments: [],
  model: null,
  effort: null,
  status: "working",
  checkpointBefore: null,
  checkpointAfter: null,
  startedAt: at,
  endedAt: null,
});

const seed = (store: EventStore["Service"]) =>
  store.commit({
    commandId: CommandId.make("seed"),
    decide: () =>
      Effect.succeed([
        DomainEvent.cases.WorkspaceRegistered.make({ workspace }),
        DomainEvent.cases.SessionCreated.make({ session }),
        DomainEvent.cases.TurnStarted.make({ turn }),
        DomainEvent.cases.TurnItemCompleted.make({
          sessionId: sId,
          turnId: tId,
          item: TurnItem.cases.AssistantMessage.make({ id: "m1", text: "hello" }),
          subagentId: null,
        }),
        DomainEvent.cases.SessionRenamed.make({ sessionId: sId, title: "Renamed" }),
      ]),
  });

describe("EventStore", () => {
  test("a closed store lets go of its database: another connection can take it exclusively", async () => {
    const file = join(tempDir("polaris-store-"), "state.sqlite");
    await run(
      file,
      Effect.flatMap(EventStore, (store) => seed(store))
    );

    // Leaving WAL needs every other connection gone; a lingering one is SQLITE_BUSY.
    const other = new Database(file);

    try {
      expect(other.query("PRAGMA journal_mode = DELETE").get()).toEqual({ journal_mode: "delete" });
    } finally {
      other.close();
    }
  });

  test("events, projections and receipt commit together and reload from disk", async () => {
    const file = join(tempDir("polaris-store-"), "state.sqlite");
    await run(
      file,
      Effect.gen(function* () {
        const store = yield* EventStore;
        const result = yield* seed(store);
        expect(result._tag).toBe("Committed");
        expect(result).toMatchObject({ sequence: 5 });
        const again = yield* seed(store);
        expect(again).toEqual(CommitResult.Duplicate({ sequence: Sequence.make(5) }));
      })
    );
    await run(
      file,
      Effect.gen(function* () {
        const store = yield* EventStore;
        const model = yield* store.model;
        expect(model.sequence).toBe(5);
        expect(model.workspaces.get(wsId)).toEqual(workspace);
        const record = model.sessions.get(sId)!;
        expect(record.session.title).toBe("Renamed");
        // The seed carried a command id, so the rename counts as the user's.
        expect(record.titleLocked).toBe(true);
        // The fold numbers the Turn and keeps its reply's preview, and both survive the reload.
        expect(record.turns).toEqual([
          patchTurn(turn, { userTurnNumber: 1, replyPreview: "hello" }),
        ]);
        const items = yield* store.readTurnItems({ turnIds: [tId], upTo: 5 });
        expect(items.get(tId)).toEqual([
          TurnItem.cases.AssistantMessage.make({ id: "m1", text: "hello" }),
        ]);
      })
    );
  });

  test("the Host stream replay leaves out per-item events", async () => {
    await run(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* seed(store);
        const host = yield* store.readEvents({ after: 0, upTo: 5, sessionId: null });
        expect(host.map((e) => e.event._tag)).toEqual([
          "WorkspaceRegistered",
          "SessionCreated",
          "TurnStarted",
          "SessionRenamed",
        ]);
        const sessionEvents = yield* store.readEvents({ after: 1, upTo: 5, sessionId: sId });
        expect(sessionEvents.map((e) => Number(e.sequence))).toEqual([2, 3, 4, 5]);
      })
    );
  });

  test("commits queued together are decided in order and settled one by one", async () => {
    const file = join(tempDir("polaris-store-"), "state.sqlite");
    await run(
      file,
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* seed(store);

        const rename = (title: string) =>
          Effect.succeed([DomainEvent.cases.SessionRenamed.make({ sessionId: sId, title })]);

        const again = CommandId.make("c-again");
        const rejected = CommandId.make("c-rejected");
        const rejection = new CommandRejected({ commandId: rejected, reason: "no" });
        const seen: Array<number> = [];

        // Forked together, these all queue before the writer runs: one batch.
        const results = yield* Effect.all(
          [
            store.commit({
              commandId: again,
              decide: (model) => {
                seen.push(model.sequence);

                return rename("first");
              },
            }),
            store.commit({ commandId: again, decide: () => rename("never") }),
            Effect.flip(
              store.commit({ commandId: rejected, decide: () => Effect.fail(rejection) })
            ),
            Effect.flip(
              store.commit<CommandRejected>({ commandId: rejected, decide: () => rename("never") })
            ),
            Effect.exit(store.commit({ commandId: null, decide: () => Effect.die("boom") })),
            store.commit({
              commandId: null,
              decide: (model) => {
                seen.push(model.sequence);

                return rename("last");
              },
            }),
          ],
          { concurrency: "unbounded" }
        );

        const [first, duplicate, rejectedOnce, rejectedAgain, died, last] = results;
        expect(first._tag).toBe("Committed");
        expect(first).toMatchObject({ sequence: 6 });
        expect(duplicate).toEqual(CommitResult.Duplicate({ sequence: Sequence.make(6) }));
        expect(rejectedOnce).toEqual(rejection);
        expect(rejectedAgain).toEqual(rejection);
        expect(Exit.isFailure(died)).toBe(true);
        expect(last._tag).toBe("Committed");
        expect(last).toMatchObject({ sequence: 7 });
        // Each decide saw the model the commands before it in the batch produced.
        expect(seen).toEqual([5, 6]);
        const model = yield* store.model;
        expect(model.sequence).toBe(7);
        expect(model.sessions.get(sId)!.session.title).toBe("last");
      })
    );
    // Everything, receipts included, reached the disk.
    await run(
      file,
      Effect.gen(function* () {
        const store = yield* EventStore;
        expect((yield* store.model).sequence).toBe(7);
        const rejected = CommandId.make("c-rejected");

        const replay = yield* Effect.flip(
          store.commit<CommandRejected>({ commandId: rejected, decide: () => Effect.succeed([]) })
        );

        expect(replay).toEqual(new CommandRejected({ commandId: rejected, reason: "no" }));
      })
    );
  });

  test("a commit queued while the drain is ending is still written", async () => {
    // A small operation budget makes the drain yield between its last check and its exit.
    const stalledWith = (budget: number) =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        const empty = () => store.commit({ commandId: null, decide: () => Effect.succeed([]) });
        const stalled: Array<number> = [];

        for (let stagger = 0; stagger < 30; stagger++) {
          const first = yield* Effect.forkChild(empty());

          const second = yield* Effect.forkChild(
            Effect.gen(function* () {
              for (let i = 0; i < stagger; i++) yield* Effect.yieldNow;

              return yield* empty();
            })
          );

          yield* Fiber.join(first);
          const settled = yield* Fiber.join(second).pipe(Effect.timeoutOption("300 millis"));

          if (Option.isNone(settled)) stalled.push(stagger);
        }

        return stalled;
      }).pipe(
        Effect.provide(EventStore.layerSqlite(":memory:")),
        Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)
      );

    for (const budget of [3, 4, 5])
      expect({ budget, stalled: await Effect.runPromise(stalledWith(budget)) }).toEqual({
        budget,
        stalled: [],
      });
  });

  test("subscribers hear of a batch only once it is committed", async () => {
    await run(
      ":memory:",
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;
          const live = yield* store.subscribe();

          const checked = yield* live.pipe(
            Stream.take(30),
            Stream.mapEffect((item) =>
              Effect.gen(function* () {
                if (!Predicate.isTagged(item, "Event")) return false;
                const sequence = item.envelope.sequence;
                const model = yield* store.model;

                const rows = yield* store.readEvents({
                  after: sequence - 1,
                  upTo: sequence,
                  sessionId: null,
                });

                return model.sequence >= sequence && rows.length === 1;
              })
            ),
            Stream.runCollect,
            Effect.forkChild
          );

          yield* Effect.forEach(
            Array.from({ length: 30 }, (_, i) => i),
            (i) =>
              store.commit({
                commandId: null,
                decide: () =>
                  Effect.succeed([
                    DomainEvent.cases.WorkspaceUpdated.make({
                      workspace: workspaceNamed(`w${i}`),
                    }),
                  ]),
              }),
            { concurrency: "unbounded", discard: true }
          );
          const results = yield* Fiber.join(checked);
          expect([...results]).toEqual(Array.from({ length: 30 }, () => true));
        })
      )
    );
  });
});
