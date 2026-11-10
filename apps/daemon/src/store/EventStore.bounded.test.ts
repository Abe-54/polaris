/**
 * Store behaviour added in ENG-194: ApprovalWithdrawn next to the legacy
 * Deny-by-Harness record, only recent Turns in memory, and bounded live
 * subscribers.
 */
import { tempDir } from "../platform/tempDir.testing.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AgentSession,
  ApprovalRequest,
  ApprovalDecision,
  DomainEvent,
  RequestId,
  SessionId,
  Turn,
  TurnId,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Layer, Predicate, Stream } from "effect";
import { EventStore, LiveItem, StoreConfig } from "./EventStore.ts";
import { RECENT_TURNS } from "./model.ts";

const run = <A, E>(filename: string, program: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(EventStore.layerSqlite(filename))));

const tempFile = () => join(tempDir("polaris-store-"), "state.sqlite");

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

const session = new AgentSession({
  id: sId,
  workspaceId: wsId,
  harness: "claude",
  title: "t",
  cwd: "/repo",
  worktreeId: null,
  state: "working",
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

const turnAt = (index: number, id = `t-${index}`, status: Turn["status"] = "completed") =>
  new Turn({
    id: TurnId.make(id),
    sessionId: sId,
    index,
    prompt: `prompt ${index}`,
    attachments: [],
    model: null,
    effort: null,
    status,
    checkpointBefore: null,
    checkpointAfter: null,
    startedAt: at,
    endedAt: status === "working" ? null : at,
  });

const requestWithId = (id: string) =>
  new ApprovalRequest({
    id: RequestId.make(id),
    sessionId: sId,
    turnId: tId,
    kind: "command",
    title: "Run",
    detail: null,
    options: [],
    openedAt: at,
  });

const request = requestWithId("r-1");

const record = (store: EventStore["Service"], events: ReadonlyArray<DomainEvent>) =>
  store.commit({ commandId: null, decide: () => Effect.succeed(events) });

const seed = (store: EventStore["Service"]) =>
  record(store, [
    DomainEvent.cases.WorkspaceRegistered.make({ workspace }),
    DomainEvent.cases.SessionCreated.make({ session }),
    DomainEvent.cases.TurnStarted.make({
      turn: turnAt(0, tId, "working"),
    }),
  ]);

describe("approvals", () => {
  test("old logs' Deny-by-Harness and ApprovalWithdrawn both clear a request, across reloads", async () => {
    const file = tempFile();
    await run(
      file,
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* seed(store);
        yield* record(store, [
          DomainEvent.cases.ApprovalRequested.make({ request }),
          // How a withdrawal was recorded before ApprovalWithdrawn existed.
          DomainEvent.cases.ApprovalResolved.make({
            sessionId: sId,
            requestId: request.id,
            decision: ApprovalDecision.cases.Deny.make({ reason: "Withdrawn by the Harness" }),
            resolvedBy: "Harness",
          }),
          DomainEvent.cases.ApprovalRequested.make({
            request: requestWithId("r-2"),
          }),
        ]);
        expect((yield* store.model).sessions.get(sId)!.pending.size).toBe(1);
        yield* record(store, [
          DomainEvent.cases.ApprovalWithdrawn.make({
            sessionId: sId,
            requestId: RequestId.make("r-2"),
            withdrawnBy: "daemon",
            reason: "The Daemon restarted",
          }),
        ]);
        expect((yield* store.model).sessions.get(sId)!.pending.size).toBe(0);
      })
    );
    await run(
      file,
      Effect.gen(function* () {
        const store = yield* EventStore;
        const model = yield* store.model;
        expect(model.sessions.get(sId)!.pending.size).toBe(0);
        const events = yield* store.readEvents({ after: 0, upTo: model.sequence, sessionId: sId });
        expect(events.map((e) => e.event._tag).slice(-4)).toEqual([
          "ApprovalRequested",
          "ApprovalResolved",
          "ApprovalRequested",
          "ApprovalWithdrawn",
        ]);
      })
    );
  });
});

describe("recent Turns", () => {
  test("only recent Turns stay in memory, on commit and on reload; older ones read from SQL", async () => {
    const file = tempFile();
    const total = RECENT_TURNS * 2 + 3;

    const check = Effect.gen(function* () {
      const store = yield* EventStore;
      const current = (yield* store.model).sessions.get(sId)!;
      expect(current.session.turnCount).toBe(total);
      expect(current.turns.map((t) => t.index)).toEqual(
        Array.from({ length: RECENT_TURNS }, (_, i) => total - RECENT_TURNS + i)
      );

      const older = yield* store.readTurns({
        sessionId: sId,
        beforeIndex: current.turns[0]!.index,
        limit: 3,
      });

      const first = total - RECENT_TURNS;
      expect(older.map((t) => t.index)).toEqual([first - 3, first - 2, first - 1]);
      const all = yield* store.readTurns({ sessionId: sId, beforeIndex: null, limit: null });
      expect(all.map((t) => t.index)).toEqual(Array.from({ length: total }, (_, i) => i));

      // A Turn no longer in memory is found by its id, under its own session only.
      const oldest = yield* store.readTurn({ sessionId: sId, turnId: TurnId.make("t-0") });
      expect(oldest).toEqual(all[0]!);
      const elsewhere = SessionId.make("s-other");
      expect(
        yield* store.readTurn({ sessionId: elsewhere, turnId: TurnId.make("t-0") })
      ).toBeNull();
      expect(yield* store.readTurn({ sessionId: sId, turnId: TurnId.make("t-none") })).toBeNull();

      // Ids come in Turn order (not id order: "t-10" sorts before "t-2"), per session asked for.
      const ids = yield* store.readTurnIds([elsewhere, sId]);
      expect([...ids]).toEqual([[sId, all.map((t) => t.id)]]);
      expect(yield* store.readTurnIds([])).toEqual(new Map());
    });

    await run(
      file,
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* record(store, [
          DomainEvent.cases.WorkspaceRegistered.make({ workspace }),
          DomainEvent.cases.SessionCreated.make({ session }),
          ...Array.from({ length: total }, (_, i) =>
            DomainEvent.cases.TurnEnded.make({ turn: turnAt(i) })
          ),
        ]);
        yield* check;
      })
    );
    await run(file, check);
  });
});

describe("live subscribers", () => {
  test("one that stops reading is dropped at capacity; ephemeral items never drop it", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* seed(store);
          const stalled = yield* store.subscribe();
          const unrelated = yield* store.subscribe({ filter: (item) => item.sessionId !== sId });

          for (let i = 0; i < 1000; i++)
            yield* store.publishEphemeral(
              LiveItem.Delta({
                sessionId: sId,
                turnId: tId,
                itemId: "m",
                field: "text",
                text: "x",
                subagentId: null,
              })
            );
          expect(yield* store.subscriberCount).toBe(2);

          const rename = (title: string) =>
            record(store, [DomainEvent.cases.SessionRenamed.make({ sessionId: sId, title })]);

          // 8 Deltas (half of 16) and 8 events fill the buffer...
          for (let i = 0; i < 8; i++) yield* rename(`t${i}`);
          expect(yield* store.subscriberCount).toBe(2);
          // ...and the next event drops the subscriber instead of skipping it.
          yield* rename("overflow");
          expect(yield* store.subscriberCount).toBe(1);
          const drained = yield* Stream.runCollect(stalled);
          expect(drained.filter((i) => Predicate.isTagged(i, "Delta"))).toHaveLength(8);
          expect(
            drained.filter((i) => Predicate.isTagged(i, "Event")).map((i) => i._tag)
          ).toHaveLength(8);
          // The filtered subscriber buffered none of this session's items, so it stays live.
          yield* record(store, [DomainEvent.cases.WorkspaceUpdated.make({ workspace })]);
          const heard = yield* Stream.runCollect(Stream.take(unrelated, 1));
          expect(
            heard.map((i) => (Predicate.isTagged(i, "Event") ? i.envelope.event._tag : i._tag))
          ).toEqual(["WorkspaceUpdated"]);
        })
      ).pipe(
        Effect.provide(
          EventStore.layerSqlite(":memory:").pipe(
            Layer.provide(Layer.succeed(StoreConfig)({ subscriberCapacity: 16 }))
          )
        )
      )
    );
  });

  test("a subscriber to one session gets only its items and is dropped at capacity like any", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* seed(store);
          const other = SessionId.make("s-other");
          const mine = yield* store.subscribe({ sessionId: sId });
          const theirs = yield* store.subscribe({ sessionId: other });

          const delta = (sessionId: SessionId, text: string) =>
            store.publishEphemeral(
              LiveItem.Delta({
                sessionId,
                turnId: tId,
                itemId: "m",
                field: "text",
                text,
                subagentId: null,
              })
            );

          yield* delta(sId, "a");
          yield* delta(other, "b");
          yield* record(store, [
            DomainEvent.cases.SessionRenamed.make({ sessionId: sId, title: "r" }),
          ]);

          const [a] = yield* Stream.runCollect(Stream.take(mine, 2)).pipe(
            Effect.map((items) => [
              items.map((i) => (Predicate.isTagged(i, "Delta") ? i.text : i._tag)),
            ])
          );

          expect(a).toEqual(["a", "Event"]);

          const [b] = yield* Stream.runCollect(Stream.take(theirs, 1)).pipe(
            Effect.map((items) => [
              items.map((i) => (Predicate.isTagged(i, "Delta") ? i.text : i._tag)),
            ])
          );

          expect(b).toEqual(["b"]);

          // Fill `mine` (nobody reads it any more) until the next event drops it.
          for (let i = 0; i < 17; i++)
            yield* record(store, [
              DomainEvent.cases.SessionRenamed.make({ sessionId: sId, title: `t${i}` }),
            ]);
          expect(yield* store.subscriberCount).toBe(1);
        })
      ).pipe(
        Effect.provide(
          EventStore.layerSqlite(":memory:").pipe(
            Layer.provide(Layer.succeed(StoreConfig)({ subscriberCapacity: 16 }))
          )
        )
      )
    );
  });
});
