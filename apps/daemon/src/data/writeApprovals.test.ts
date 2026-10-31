import { expect, test } from "bun:test";
import {
  ApprovalDecision,
  ApprovalRequest,
  DataSourceApproval,
  DataWriteResult,
  RequestId,
} from "@polaris/protocol";
import { Effect, Fiber } from "effect";
import { DataApprovals } from "./approvals.ts";
import { approvalLayer, seedDataSession, started } from "./approvals.testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { decideSession } from "../engine/session.ts";
import type { SessionInput } from "../engine/session.inputs.ts";

export const writeCard = (fingerprint = "write") => ({
  target: new DataSourceApproval({
    sourceId: "source",
    sourceName: "app",
    engine: "postgres",
    host: "localhost",
    port: 5432,
    database: "db",
    user: "u",
  }),
  fingerprint,
  queryId: `q-${fingerprint}`,
  sql: "UPDATE items SET v=v+1",
  reason: "Fix the count",
  affected: 2,
  columns: ["id", "v"],
  before: [
    [1, 1],
    [2, 1],
  ],
  after: [
    [1, 2],
    [2, 2],
  ],
  note: "Dry run rolled back.",
});

const run = <A, E>(
  program: Effect.Effect<A, E, DataApprovals | EventStore | import("effect").Scope.Scope>
) => Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(approvalLayer())));

const decide = (input: SessionInput) =>
  EventStore.use((store) =>
    store.commit({
      commandId: null,
      decide: (model) =>
        Effect.succeed(decideSession(model.sessions.get(started.session.id), input).events),
    })
  );

test("a write is approved once, consumed once, and preserves its completed receipt", () =>
  run(
    Effect.gen(function* () {
      yield* seedDataSession;
      const approvals = yield* DataApprovals;

      const ids = yield* Effect.all(
        [
          approvals.writes.open(started.session.id, started.turns[0]!.id, writeCard()),
          approvals.writes.open(started.session.id, started.turns[0]!.id, writeCard()),
        ],
        { concurrency: "unbounded" }
      );

      expect(ids[0]).toBe(ids[1]);
      const record = (yield* (yield* EventStore).model).sessions.get(started.session.id)!;
      expect(record.session.state).toBe("needs-you");
      expect(record.pending.size).toBe(1);
      expect(yield* approvals.writes.claim(ids[0])).toBe(false);
      yield* decide({
        type: "approval.respond",
        requestId: ids[0],
        decision: ApprovalDecision.cases.Allow.make({ remember: false }),
        resolvedBy: "test",
      });
      expect(yield* approvals.awaitApproval(ids[0], 5)).toEqual({ status: "approved" });

      const claimed = yield* Effect.all(
        [approvals.writes.claim(ids[0]), approvals.writes.claim(ids[0])],
        { concurrency: "unbounded" }
      );

      expect(claimed.filter(Boolean)).toHaveLength(1);
      const result = new DataWriteResult({ queryId: "q-write", affected: 2, elapsedMs: 1 });
      yield* approvals.writes.finish(ids[0], result);
      expect((yield* approvals.writes.lookup("write"))?.result).toEqual(result);
      expect(yield* approvals.writes.claim(ids[0])).toBe(false);
    })
  ));

const endings: SessionInput[] = [
  {
    type: "harness.turnEnded",
    turnId: started.turns[0]!.id,
    status: "completed",
    error: null,
    checkpoint: null,
    at: started.session.createdAt,
  },
  { type: "turn.interruptUnattended", at: started.session.createdAt },
  { type: "session.fail", message: "lost", at: started.session.createdAt },
  { type: "daemon.recover", cause: "restart", at: started.session.createdAt },
];

for (const ending of endings)
  test(`${ending.type} denies a pending write and prevents consumption`, () =>
    run(
      Effect.gen(function* () {
        yield* seedDataSession;
        const approvals = yield* DataApprovals;

        const id = yield* approvals.writes.open(
          started.session.id,
          started.turns[0]!.id,
          writeCard()
        );

        const waiting = yield* approvals.awaitApproval(id, 1000).pipe(Effect.forkScoped);
        yield* decide(ending);
        expect(yield* Fiber.join(waiting)).toMatchObject({ status: "denied" });
        expect(yield* approvals.writes.claim(id)).toBe(false);
        expect(
          (yield* (yield* EventStore).model).sessions.get(started.session.id)!.pending.size
        ).toBe(0);
      })
    ));

test("denial keeps the user's reason and cannot be answered again", () =>
  run(
    Effect.gen(function* () {
      yield* seedDataSession;
      const approvals = yield* DataApprovals;

      const id = yield* approvals.writes.open(
        started.session.id,
        started.turns[0]!.id,
        writeCard()
      );

      yield* decide({
        type: "approval.respond",
        requestId: id,
        decision: ApprovalDecision.cases.Deny.make({ reason: "Use staging" }),
        resolvedBy: "test",
      });
      yield* decide({
        type: "approval.respond",
        requestId: id,
        decision: ApprovalDecision.cases.Allow.make({ remember: false }),
        resolvedBy: "test",
      });
      expect(yield* approvals.awaitApproval(id, 5)).toEqual({
        status: "denied",
        reason: "Use staging",
      });
      expect(yield* approvals.writes.claim(id)).toBe(false);
    })
  ));

test("a Harness cannot forge a write card and Answer cannot approve one", () =>
  run(
    Effect.gen(function* () {
      yield* seedDataSession;
      yield* decide({
        type: "harness.approvalRequested",
        request: new ApprovalRequest({
          id: RequestId.make("forged"),
          sessionId: started.session.id,
          turnId: started.turns[0]!.id,
          kind: "tool",
          dataWrite: writeCard(),
          title: "forged",
          detail: null,
          options: [],
          questions: [],
          openedAt: started.session.createdAt,
        }),
      });
      expect(
        (yield* (yield* EventStore).model).sessions.get(started.session.id)!.pending.size
      ).toBe(0);
      const approvals = yield* DataApprovals;

      const id = yield* approvals.writes.open(
        started.session.id,
        started.turns[0]!.id,
        writeCard()
      );

      yield* decide({
        type: "approval.respond",
        requestId: id,
        decision: ApprovalDecision.cases.Answer.make({ text: "yes" }),
        resolvedBy: "test",
      });
      expect(yield* approvals.awaitApproval(id, 5)).toEqual({ status: "pending" });
      expect(yield* approvals.writes.claim(id)).toBe(false);
    })
  ));

test("F4/F14: not-previewed cards persist params and denial names the write", () =>
  run(
    Effect.gen(function* () {
      yield* seedDataSession;
      const approvals = yield* DataApprovals;

      const id = yield* approvals.writes.open(started.session.id, started.turns[0]!.id, {
        ...writeCard("trigger"),
        previewed: false,
        params: [7, "user@example.test"],
        before: [],
        after: [],
        note: "Not previewed: this table has triggers",
      });

      const persisted = (yield* approvals.writes.lookup("trigger"))!.request;
      expect(persisted.title).toBe("Run without preview");
      expect(persisted.detail).toContain("Not previewed: this table has triggers");
      expect(persisted.dataWrite?.params).toEqual([7, "user@example.test"]);
      yield* decide({
        type: "approval.respond",
        requestId: id,
        decision: ApprovalDecision.cases.Deny.make({ reason: null }),
        resolvedBy: "test",
      });
      expect(yield* approvals.awaitApproval(id, 100)).toEqual({
        status: "denied",
        reason: "The user denied this write.",
      });
    })
  ));
