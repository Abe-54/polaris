import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CommandId,
  WorkerPlacement,
  MessageTarget,
  PlanOperation,
  ReviewAction,
  type ConstellationCommand,
} from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { TestClock } from "effect/testing";
import { B, C, CID, HOST, ctx, draft, report, task } from "../../engine/constellation.testing.ts";
import { decideConstellation } from "../../engine/constellation.ts";
import type { ConstellationContext } from "../../engine/constellation.inputs.ts";
import { EventStore } from "../../store/EventStore.ts";
import { Constellations } from "../service.ts";
import { ConstellationDelivery } from "./index.ts";
import { pendingInputs } from "./messages.ts";
import { finish, send, setup, STANDALONE, wait, WORKER, world } from "./testing.ts";

const id = () => CommandId.make(crypto.randomUUID());

const worker = { kind: "session" as const, sessionId: WORKER };

const block = (on = [B]) =>
  C.WorkerBlock.make({
    constellationId: CID,
    attemptId: draft().id,
    on,
    reason: "Waiting for feed",
  });

const commit = Effect.fnUntraced(function* (
  command: ConstellationCommand,
  context: ConstellationContext = ctx()
) {
  const store = yield* EventStore;
  yield* TestClock.adjust(1);

  return yield* store.commit({
    commandId: null,
    decide: (model) => {
      const decision = decideConstellation(model.constellations.get(CID), command, context);
      expect(decision.rejection).toBeNull();

      return Effect.succeed(decision.events);
    },
  });
});

const addFeed = () =>
  commit(
    C.Plan.make({
      constellationId: CID,
      operations: [PlanOperation.cases.Add.make({ task: task(B) })],
    })
  );

const acceptFeed = Effect.fnUntraced(function* () {
  const feed = draft(B, "feed", STANDALONE);
  yield* commit(
    C.Dispatch.make({
      constellationId: CID,
      tasks: [
        { taskId: B, worker: WorkerPlacement.cases.Existing.make({ sessionId: STANDALONE }) },
      ],
    }),
    ctx({ attempts: [feed] })
  );
  const claim = report(feed.branch, "feed-head");
  yield* commit(
    C.WorkerClaim.make({ constellationId: CID, attemptId: feed.id, claim }),
    ctx({
      binding: { kind: "session", sessionId: STANDALONE },
      claimProbe: { dirtyPaths: [], branch: feed.branch, head: claim.head },
    })
  );
  yield* commit(
    C.Review.make({
      constellationId: CID,
      attemptId: feed.id,
      revision: 1,
      action: ReviewAction.cases.Accept.make({ mergedHead: claim.head, receipts: [] }),
    })
  );
});

test("acceptance waits for the worker's Turn boundary, skips nudging and commits unblock with its Turn", async () => {
  const w = world();
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      yield* addFeed();
      yield* send(WORKER);
      const graphs = yield* Constellations;
      const delivery = yield* ConstellationDelivery;
      const store = yield* EventStore;
      yield* graphs.command(worker, id(), block());
      yield* delivery.start();
      yield* acceptFeed();
      yield* delivery.flush();
      expect(w.turns).toHaveLength(0);
      yield* finish(WORKER);
      yield* wait(() => Effect.succeed(w.turns.length === 1));
      expect(w.prompts[0]).toBe(
        "B accepted at feed-head. Merge it into your branch and continue A; call claim when finished, or block again."
      );
      const model = yield* store.model;
      const attempt = model.constellations.get(CID)!.graph.attempts[0]!;
      expect(attempt).toMatchObject({
        state: "working",
        blockedOn: [],
        blockedReason: null,
        blockedAt: null,
        nudgedAt: null,
      });

      const events = yield* store.readConstellationEvents({
        constellationId: CID,
        after: 0,
        upTo: model.sequence,
      });

      const marker = events.findIndex((e) => Predicate.isTagged(e.event, "AttemptUnblocked"));
      expect(marker).toBeGreaterThanOrEqual(0);

      const turns = yield* store.readEvents({
        after: events[marker]!.sequence - 3,
        upTo: events[marker]!.sequence,
        sessionId: WORKER,
      });

      const started = turns.find((e) => Predicate.isTagged(e.event, "TurnStarted"))!;
      expect(started).toBeDefined();
      expect(started.occurredAt).toBe(events[marker]!.occurredAt);
      yield* delivery.flush();
      expect(w.turns).toHaveLength(1);
    })
  );
});

test("blocked inputs survive a Daemon restart before delivery and cannot unblock twice", async () => {
  const dir = newTempDir("polaris-blocked-");
  const file = join(dir, "store.sqlite");

  try {
    const before = world(file);
    await before.run(
      Effect.gen(function* () {
        yield* TestClock.adjust(1);
        yield* setup();
        yield* addFeed();
        yield* send(WORKER);
        const graphs = yield* Constellations;
        yield* graphs.command(worker, id(), block());
        yield* finish(WORKER);
        yield* acceptFeed();
        const model = yield* (yield* EventStore).model;
        expect(pendingInputs(model.constellations.get(CID)!)).toHaveLength(1);
      })
    );
    const resumed = world(file);
    await resumed.run(
      Effect.gen(function* () {
        const delivery = yield* ConstellationDelivery;
        yield* TestClock.adjust(100);
        yield* delivery.start();
        yield* delivery.flush();
        expect(resumed.turns).toHaveLength(1);
        yield* finish(WORKER, "interrupted");
      })
    );
    const after = world(file);
    await after.run(
      Effect.gen(function* () {
        const delivery = yield* ConstellationDelivery;
        const store = yield* EventStore;
        yield* delivery.start();
        yield* delivery.flush();
        expect(after.turns).toHaveLength(0);
        const model = yield* store.model;

        const events = yield* store.readConstellationEvents({
          constellationId: CID,
          after: 0,
          upTo: model.sequence,
        });

        expect(events.filter((e) => Predicate.isTagged(e.event, "AttemptUnblocked"))).toHaveLength(
          1
        );

        if (process.env.POLARIS_TRACE_DIR !== undefined) {
          const sessionEvents = yield* store.readEvents({
            after: 0,
            upTo: model.sequence,
            sessionId: WORKER,
          });

          const batches = Map.groupBy(
            [...events, ...sessionEvents].sort((a, b) => a.sequence - b.sequence),
            (e) => e.occurredAt
          );

          writeFileSync(
            join(process.env.POLARIS_TRACE_DIR, "constellation-blocked-restart.json"),
            JSON.stringify({
              version: 1,
              ownerHostId: HOST,
              batches: [...batches.values()].map((batch) => ({
                hostId: HOST,
                context: { offlineSessionIds: [], commanded: true },
                events: batch.map((e) => e.event),
              })),
            })
          );
        }
      })
    );
  } finally {
    removeTempDir(dir);
  }
});

test("reason-only blocks wait for a Lead message and notify the digest; peers do not unblock", async () => {
  const w = world();
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      yield* send(WORKER);
      const graphs = yield* Constellations;
      const delivery = yield* ConstellationDelivery;
      yield* graphs.command(worker, id(), block([]));
      yield* finish(WORKER);
      yield* delivery.start();
      yield* delivery.flush();
      expect(w.turns).toHaveLength(0);
      yield* graphs.command(
        { kind: "user" },
        id(),
        C.Message.make({
          constellationId: CID,
          target: MessageTarget.cases.All.make({}),
          text: "General update for everyone",
        })
      );
      yield* delivery.flush();
      expect(w.turns.filter((t) => t.sessionId === WORKER)).toHaveLength(0);
      expect(
        (yield* (yield* EventStore).model).constellations.get(CID)!.graph.attempts[0]!.state
      ).toBe("blocked");
      yield* TestClock.adjust(20000);
      yield* wait(() => Effect.succeed(w.turns.length === 1));
      expect(w.prompts[0]).toContain("A: blocked awaiting the Lead: Waiting for feed");
      yield* graphs.command(
        { kind: "user" },
        id(),
        C.Message.make({
          constellationId: CID,
          target: MessageTarget.cases.Worker.make({ attemptId: draft().id }),
          text: "Proceed with the existing API",
        })
      );
      yield* delivery.flush();
      expect(w.turns).toHaveLength(2);
      const model = yield* (yield* EventStore).model;
      expect(model.constellations.get(CID)!.graph.attempts[0]!.state).toBe("working");
    })
  );
});

test("second silent end queues Stopped once and reaches the Lead digest", async () => {
  const w = world();
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      yield* send(WORKER);
      const delivery = yield* ConstellationDelivery;
      const store = yield* EventStore;
      yield* delivery.start();
      yield* finish(WORKER);
      yield* wait(() => Effect.succeed(w.turns.length === 1));
      expect(w.prompts[0]).toContain("call block");
      yield* finish(WORKER);
      yield* wait(() =>
        Effect.map(
          store.model,
          (m) => m.constellations.get(CID)!.graph.pendingNotifications.length === 1
        )
      );
      yield* delivery.flush();
      expect(
        (yield* store.model).constellations.get(CID)!.graph.pendingNotifications[0]!.item._tag
      ).toBe("Stopped");
      yield* TestClock.adjust(20000);
      yield* wait(() => Effect.succeed(w.turns.length === 2));
      expect(w.prompts[1]).toContain("A stopped without claiming.");
    })
  );
});

test("a restart during the blocked Turn waits, then acceptance starts its next Turn atomically", async () => {
  const w = world();
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      yield* addFeed();
      yield* send(WORKER);
      const graphs = yield* Constellations;
      const store = yield* EventStore;
      const delivery = yield* ConstellationDelivery;
      yield* graphs.command(worker, id(), block());
      yield* recoverSession({ store }, WORKER, "restart", new Date().toISOString());
      expect((yield* store.model).sessions.get(WORKER)!.session.state).toBe("needs-you");
      yield* delivery.start();
      yield* delivery.flush();
      expect(w.turns).toHaveLength(0);
      yield* acceptFeed();
      yield* delivery.flush();
      expect(w.turns).toHaveLength(1);
      expect((yield* store.model).constellations.get(CID)!.graph.attempts[0]!.state).toBe(
        "working"
      );
      expect(w.prompts[0]).toContain("B accepted at feed-head");
    })
  );
});

import { recoverSession } from "../../engine/recovery.constellation.ts";

test("peer messages remain queued while blocked and do not start or steer the worker", async () => {
  const w = world();
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      yield* addFeed();
      const feed = draft(B, "feed", STANDALONE);
      yield* commit(
        C.Dispatch.make({
          constellationId: CID,
          tasks: [
            { taskId: B, worker: WorkerPlacement.cases.Existing.make({ sessionId: STANDALONE }) },
          ],
        }),
        ctx({ attempts: [feed] })
      );
      yield* send(WORKER);
      const graphs = yield* Constellations;
      const delivery = yield* ConstellationDelivery;
      yield* graphs.command(worker, id(), block());
      yield* finish(WORKER);
      yield* commit(
        C.WorkerMessage.make({
          constellationId: CID,
          attemptId: feed.id,
          to: draft().taskId,
          text: "Still building the feed",
        }),
        ctx({ binding: { kind: "session", sessionId: STANDALONE } })
      );
      yield* delivery.start();
      yield* delivery.flush();
      expect(w.turns).toHaveLength(0);
      expect(w.steers).toHaveLength(0);
      const model = yield* (yield* EventStore).model;
      expect(model.constellations.get(CID)!.graph.attempts[0]!.state).toBe("blocked");
      expect(pendingInputs(model.constellations.get(CID)!)).toHaveLength(1);
    })
  );
});

test("a crash after the unblock commit recovers its Turn without producing another unblock", async () => {
  const dir = newTempDir("polaris-unblock-commit-");
  const file = join(dir, "store.sqlite");

  try {
    await world(file).run(
      Effect.gen(function* () {
        yield* setup();
        yield* addFeed();
        yield* send(WORKER);
        const graphs = yield* Constellations;
        const store = yield* EventStore;
        yield* graphs.command(worker, id(), block());
        yield* finish(WORKER);
        yield* acceptFeed();
        const input = pendingInputs((yield* store.model).constellations.get(CID)!)[0]!;
        const effects = yield* ConstellationSessionEffects;
        yield* deliverLocalInput(CID, input).pipe(
          Effect.provideService(ConstellationSessionEffects, {
            ...effects,
            runTurn: () => Effect.void,
          }),
          Effect.provideService(ConstellationOwner, HOST)
        );
        expect((yield* store.model).sessions.get(WORKER)!.session.state).toBe("working");
      })
    );
    const resumed = world(file);
    await resumed.run(
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* recoverSession({ store }, WORKER, "restart", new Date().toISOString());
        const proof = (yield* store.model).constellations.get(CID)!.interruptions.get(draft().id)!;
        yield* recoverAttempt({ sessionId: WORKER, interruptionId: proof.interruptionId }).pipe(
          Effect.provideService(ConstellationOwner, HOST)
        );
        expect(resumed.turns).toHaveLength(1);

        const events = yield* store.readConstellationEvents({
          constellationId: CID,
          after: 0,
          upTo: (yield* store.model).sequence,
        });

        expect(events.filter((e) => Predicate.isTagged(e.event, "AttemptUnblocked"))).toHaveLength(
          1
        );
        yield* recoverAttempt({ sessionId: WORKER, interruptionId: proof.interruptionId }).pipe(
          Effect.provideService(ConstellationOwner, HOST)
        );
        expect(resumed.turns).toHaveLength(1);
      })
    );
  } finally {
    removeTempDir(dir);
  }
});

import { ConstellationSessionEffects } from "./inputs.ts";
import { deliverLocalInput } from "./local.ts";
import { recoverAttempt } from "../recovery.ts";
import { ConstellationOwner } from "../runtime.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

test("only a Lead message sent after the block resumes it, even within the same clock tick", async () => {
  const w = world();
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      yield* send(WORKER);
      const graphs = yield* Constellations;
      const delivery = yield* ConstellationDelivery;
      const store = yield* EventStore;

      const message = (text: string) =>
        graphs.command(
          { kind: "user" },
          id(),
          C.Message.make({
            constellationId: CID,
            target: MessageTarget.cases.Worker.make({ attemptId: draft().id }),
            text,
          })
        );

      yield* message("Earlier queued message");
      yield* graphs.command(worker, id(), block([]));
      yield* finish(WORKER);
      yield* delivery.start();
      yield* delivery.flush();
      expect(w.turns).toHaveLength(0);
      expect((yield* store.model).constellations.get(CID)!.graph.attempts[0]!.state).toBe(
        "blocked"
      );
      yield* message("Fresh instruction");
      yield* delivery.flush();
      expect(w.turns).toHaveLength(1);
      expect(w.prompts[0]).toContain("Fresh instruction");
      expect((yield* store.model).constellations.get(CID)!.graph.attempts[0]!.state).toBe(
        "working"
      );
      yield* delivery.flush();
      expect(w.turns).toHaveLength(1);
    })
  );
});

test("unblock clears an earlier nudge so the resumed Attempt can be nudged once again", async () => {
  const w = world();
  await w.run(
    Effect.gen(function* () {
      yield* setup();
      yield* send(WORKER);
      const graphs = yield* Constellations;
      const delivery = yield* ConstellationDelivery;
      const store = yield* EventStore;
      yield* delivery.start();
      yield* finish(WORKER);
      yield* wait(() => Effect.succeed(w.turns.length === 1));
      expect(
        (yield* store.model).constellations.get(CID)!.graph.attempts[0]!.nudgedAt
      ).not.toBeNull();
      yield* graphs.command(worker, id(), block([]));
      yield* finish(WORKER);
      yield* graphs.command(
        { kind: "user" },
        id(),
        C.Message.make({
          constellationId: CID,
          target: MessageTarget.cases.Worker.make({ attemptId: draft().id }),
          text: "Continue",
        })
      );
      yield* delivery.flush();
      expect(w.turns).toHaveLength(2);
      expect((yield* store.model).constellations.get(CID)!.graph.attempts[0]!.nudgedAt).toBeNull();
      yield* finish(WORKER);
      yield* wait(() => Effect.succeed(w.turns.length === 3));
      expect(w.prompts[2]).toContain("call block");
    })
  );
});
