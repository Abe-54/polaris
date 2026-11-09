import { expect, test } from "bun:test";
import { ApprovalDecision, ApprovalRequest, RequestId, type HttpMethod } from "@polaris/protocol";
import { Effect, Fiber, Layer, Predicate, Schema, type Scope } from "effect";
import { EventStore } from "../../store/EventStore.ts";
import { DataDatabase } from "../../data/database.ts";
import { decideSession } from "../../engine/session.ts";
import { seedDataSession, started } from "../../data/approvals.testing.ts";
import { OriginApprovals, READS_ONLY, originApprovalsLayer, type OwnerLookup } from "./index.ts";

const sessionId = started.session.id;

const API = "https://api.example.com";

const tunnel: OwnerLookup = async () => [{ pid: 7, executable: "/usr/local/bin/cloudflared" }];

const run = <A, E>(
  program: Effect.Effect<A, E, OriginApprovals | EventStore | Scope.Scope>,
  owners: OwnerLookup = tunnel
) =>
  Effect.runPromise(
    Effect.scoped(Effect.andThen(seedDataSession, program)).pipe(
      Effect.provide(
        originApprovalsLayer({ owners, platform: "darwin" }).pipe(
          Layer.provideMerge(DataDatabase.layerAt(":memory:")),
          Layer.provideMerge(EventStore.layerSqlite(":memory:"))
        )
      )
    )
  );

/** The approval id the Send waits on, or undefined when it went straight through. */
const send = (method: HttpMethod, url = `${API}/v1/items`, approvalId?: RequestId) =>
  Effect.gen(function* () {
    const approvals = yield* OriginApprovals;

    const result = yield* approvals
      .require(sessionId, { url, method }, approvalId ? { approvalId } : {})
      .pipe(Effect.as(undefined), Effect.catchTag("OriginApprovalRequired", Effect.succeed));

    return result?.approvalId;
  });

const respond = (requestId: RequestId, decision: ApprovalDecision) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    yield* store.commit({
      commandId: null,
      decide: (model) =>
        Effect.succeed(
          decideSession(model.sessions.get(sessionId), {
            type: "approval.respond",
            requestId,
            decision,
            resolvedBy: "test",
          }).events
        ),
    });
  });

const pending = Effect.gen(function* () {
  const record = (yield* (yield* EventStore).model).sessions.get(sessionId)!;

  return [...record.pending.values()];
});

const allow = (originScope: "reads" | "reads-and-writes", remember = true) =>
  ApprovalDecision.cases.Allow.make({ remember, originScope });

test("concurrent agent Sends to one Remote Origin open exactly one card with its origin", () =>
  run(
    Effect.gen(function* () {
      const ids = yield* Effect.all([send("POST"), send("GET", `${API}/v1/other`)], {
        concurrency: "unbounded",
      });

      expect(ids[0]).toBeString();
      expect(ids[1]).toBe(ids[0]);
      const cards = yield* pending;
      expect(cards).toHaveLength(1);
      expect(cards[0]!.kind).toBe("tool");
      expect(cards[0]!.origin?.origin).toBe("https://api.example.com:443");
      expect(cards[0]!.origin?.write).toBe(cards[0]!.origin?.method === "POST");
      const record = (yield* (yield* EventStore).model).sessions.get(sessionId)!;
      expect(record.session.state).toBe("needs-you");
    })
  ));

for (const [owner, asks] of [
  ["/usr/local/bin/cloudflared", true],
  ["/opt/homebrew/bin/node", false],
] as const)
  test(`a localhost origin served by ${owner} ${asks ? "asks" : "doesn't ask"}`, () =>
    run(
      Effect.gen(function* () {
        const id = yield* send("DELETE", "http://localhost:8787/v1/items/1");
        expect(id !== undefined).toBe(asks);
        expect(yield* pending).toHaveLength(asks ? 1 : 0);
      }),
      async () => [{ pid: 9, executable: owner }]
    ));

test("a reads-only approval denies the pending write, then lets GET through and asks for POST", () =>
  run(
    Effect.gen(function* () {
      const approvals = yield* OriginApprovals;
      const id = (yield* send("POST"))!;
      const wait = yield* approvals.awaitApproval(id, true, 1000).pipe(Effect.forkScoped);
      yield* respond(id, allow("reads"));
      expect(yield* Fiber.join(wait)).toEqual({ status: "denied", reason: READS_ONLY });

      expect(yield* send("GET")).toBeUndefined();
      expect(yield* send("HEAD", `${API}/elsewhere`)).toBeUndefined();
      expect(yield* send("POST")).toBeString();
      expect(yield* pending).toHaveLength(1);
    })
  ));

test("a remembered approval skips the prompt until it's revoked", () =>
  run(
    Effect.gen(function* () {
      const approvals = yield* OriginApprovals;
      const id = (yield* send("PUT"))!;
      yield* respond(id, allow("reads-and-writes"));
      expect(yield* approvals.awaitApproval(id, true, 10)).toEqual({ status: "approved" });

      expect(yield* send("PATCH")).toBeUndefined();
      expect(yield* pending).toHaveLength(0);
      expect(yield* approvals.rules).toEqual([
        { origin: "https://api.example.com:443", scope: "reads-and-writes" },
      ]);
      // Another port is another origin.
      expect(yield* send("GET", "https://api.example.com:8443/")).toBeString();

      yield* approvals.revoke("https://api.example.com:443");
      expect(yield* approvals.rules).toEqual([]);
      expect(yield* send("PATCH")).toBeString();
    })
  ));

test("allow once lets the waiting Send through once", () =>
  run(
    Effect.gen(function* () {
      const id = (yield* send("POST"))!;
      yield* respond(id, allow("reads-and-writes", false));
      expect(yield* send("POST", undefined, id)).toBeUndefined();
      expect(yield* send("POST", undefined, id)).toBeString();
    })
  ));

test("a deny answers the Send with its reason and isn't remembered", () =>
  run(
    Effect.gen(function* () {
      const approvals = yield* OriginApprovals;
      const id = (yield* send("GET"))!;
      yield* respond(id, ApprovalDecision.cases.Deny.make({ reason: "Use staging" }));
      expect(yield* approvals.awaitApproval(id, false, 10)).toEqual({
        status: "denied",
        reason: "Use staging",
      });
      expect(yield* send("GET")).toBeString();
    })
  ));

test("only the Daemon raises an Origin Approval, and it takes no text answer", () =>
  run(
    Effect.gen(function* () {
      const id = (yield* send("GET"))!;
      const record = (yield* (yield* EventStore).model).sessions.get(sessionId)!;

      const answered = decideSession(record, {
        type: "approval.respond",
        requestId: id,
        decision: ApprovalDecision.cases.Answer.make({ text: "sure" }),
        resolvedBy: "test",
      });

      expect(answered.events.some((e) => Predicate.isTagged(e, "ApprovalResolved"))).toBe(false);

      const harness = decideSession(record, {
        type: "harness.approvalRequested",
        request: new ApprovalRequest({
          ...Schema.decodeUnknownSync(Schema.Struct(ApprovalRequest.fields))((yield* pending)[0]),
          id: RequestId.make("harness"),
        }),
      });

      expect(harness.events.some((e) => Predicate.isTagged(e, "ApprovalRequested"))).toBe(false);
    })
  ));
