import { expect, test } from "bun:test";
import { ApprovalDecision, DataSource } from "@polaris/protocol";
import { Effect, Fiber, Predicate, Schema } from "effect";
import { DataApprovals } from "./approvals.ts";
import { approvalLayer, seedDataSession, started } from "./approvals.testing.ts";
import { EventStore } from "../store/EventStore.ts";
import type { SessionInput } from "../engine/session.inputs.ts";
import { decideSession } from "../engine/session.ts";

export const remote = new DataSource({
  id: "remote",
  name: "remote",
  engine: "postgres",
  host: "db.example",
  port: 5432,
  database: "app",
  user: "reader",
  locality: "remote",
  foundIn: { kind: "manual" },
  access: "needs-approval",
  writes: "off",
  label: { text: "", colour: "none" },
  reachable: true,
});

const run = <A, E>(
  program: Effect.Effect<A, E, DataApprovals | EventStore | import("effect").Scope.Scope>
) => Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(approvalLayer())));

const request = Effect.gen(function* () {
  const approvals = yield* DataApprovals;
  const result = yield* Effect.flip(approvals.require(started.session.id, remote));

  if (!Predicate.isTagged(result, "DataApprovalRequired")) throw new Error(result.message);

  return result.approvalId;
});

test("concurrent requests share one needs-you card; a bounded wait leaves it pending", () =>
  run(
    Effect.gen(function* () {
      yield* seedDataSession;
      const ids = yield* Effect.all([request, request], { concurrency: "unbounded" });
      expect(ids[0]).toBe(ids[1]);
      const approvals = yield* DataApprovals;
      expect(yield* approvals.awaitApproval(ids[0], 5)).toEqual({ status: "pending" });
      const record = (yield* (yield* EventStore).model).sessions.get(started.session.id)!;
      expect(record.session.state).toBe("needs-you");
      expect(record.pending.size).toBe(1);
    })
  ));

for (const scope of ["target", "server"] as const)
  test(`remembered ${scope} approval gates changed targets`, () =>
    run(
      Effect.gen(function* () {
        yield* seedDataSession;
        const id = yield* request;
        const approvals = yield* DataApprovals;
        const wait = yield* approvals.awaitApproval(id, 1000).pipe(Effect.forkScoped);
        const store = yield* EventStore;
        yield* store.commit({
          commandId: null,
          decide: (model) =>
            Effect.succeed(
              decideSession(model.sessions.get(started.session.id), {
                type: "approval.respond",
                requestId: id,
                decision: ApprovalDecision.cases.Allow.make({ remember: true, dataScope: scope }),
                resolvedBy: "test",
              }).events
            ),
        });
        expect(yield* Fiber.join(wait)).toEqual({ status: "approved" });
        expect((yield* approvals.read(remote)).access).toBe("approved");

        const changed = new DataSource({
          ...Schema.decodeUnknownSync(Schema.Struct(DataSource.fields))(remote),
          database: "other",
        });

        expect((yield* approvals.read(changed)).access).toBe(
          scope === "server" ? "approved" : "needs-approval"
        );
        expect(
          (yield* approvals.read(
            new DataSource({
              ...Schema.decodeUnknownSync(Schema.Struct(DataSource.fields))(remote),
              host: "different.example",
            })
          )).access
        ).toBe("needs-approval");
        yield* approvals.change(remote, undefined, true);
        expect((yield* approvals.read(remote)).access).toBe("needs-approval");
      })
    ));

test("deny closes the card, preserves the reason, and blocks retries without a second card", () =>
  run(
    Effect.gen(function* () {
      yield* seedDataSession;
      const id = yield* request;
      const approvals = yield* DataApprovals;
      const store = yield* EventStore;
      yield* store.commit({
        commandId: null,
        decide: (model) =>
          Effect.succeed(
            decideSession(model.sessions.get(started.session.id), {
              type: "approval.respond",
              requestId: id,
              decision: ApprovalDecision.cases.Deny.make({ reason: "Use staging" }),
              resolvedBy: "test",
            }).events
          ),
      });
      expect(yield* approvals.awaitApproval(id, 10)).toEqual({
        status: "denied",
        reason: "Use staging",
      });
      expect(yield* Effect.flip(approvals.require(started.session.id, remote))).toMatchObject({
        code: "E-DATA-DENIED",
      });
      const record = (yield* store.model).sessions.get(started.session.id)!;
      expect(record.pending.size).toBe(0);
      expect(record.session.state).toBe("working");
    })
  ));

const endingInputs: ReadonlyArray<SessionInput> = [
  {
    type: "harness.turnEnded",
    turnId: started.turns[0]!.id,
    status: "completed",
    error: null,
    checkpoint: null,
    at: started.session.createdAt,
  },
  { type: "turn.interruptUnattended", at: started.session.createdAt },
  { type: "session.fail", message: "Harness lost", at: started.session.createdAt },
  { type: "daemon.recover", cause: "restart", at: started.session.createdAt },
];

for (const input of endingInputs)
  test(`${input.type} withdraws Data approvals and wakes the waiter`, () =>
    run(
      Effect.gen(function* () {
        yield* seedDataSession;
        const id = yield* request;
        const approvals = yield* DataApprovals;
        const wait = yield* approvals.awaitApproval(id, 1000).pipe(Effect.forkScoped);
        const store = yield* EventStore;
        yield* store.commit({
          commandId: null,
          decide: (model) =>
            Effect.succeed(decideSession(model.sessions.get(started.session.id), input).events),
        });
        expect(yield* Fiber.join(wait)).toMatchObject({ status: "denied" });
        expect((yield* store.model).sessions.get(started.session.id)!.pending.size).toBe(0);
        expect((yield* approvals.read(remote)).access).toBe("needs-approval");
      })
    ));
