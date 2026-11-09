/** A real send engine, Origin Approvals and EventStore behind the MCP tools, for send_request tests. */
import { join } from "node:path";
import { ApprovalDecision, type RequestId } from "@polaris/protocol";
import { Effect, Layer, type Scope } from "effect";
import { EventStore } from "../../store/EventStore.ts";
import { DataDatabase } from "../../data/database.ts";
import { decideSession } from "../../engine/session.ts";
import { seedDataSessionAt, started } from "../../data/approvals.testing.ts";
import { TraceSessions } from "../../traces/sessionsService.ts";
import { TraceStore } from "../../traces/storeService.ts";
import { TEST_SESSION, type TraceFixture } from "../../traces/testing.ts";
import { RequestSends } from "../../requests/sendsService.ts";
import {
  OriginApprovals,
  originApprovalsLayer,
  type OwnerLookup,
} from "../../requests/approvals/index.ts";

export const sessionId = started.session.id;

export const nodeOwner: OwnerLookup = async () => [
  { pid: 9, executable: "/opt/homebrew/bin/node" },
];

export const tunnelOwner: OwnerLookup = async () => [
  { pid: 7, executable: "/usr/local/bin/cloudflared" },
];

type Services = EventStore | OriginApprovals | RequestSends | DataDatabase | Scope.Scope;

/** Runs `program` with the session seeded in `fixture.root` and its Turn in flight. */
export const runWithSends = <A, E>(
  fixture: TraceFixture,
  owners: OwnerLookup,
  program: Effect.Effect<A, E, Services>
) =>
  Effect.runPromise(
    Effect.scoped(Effect.andThen(seedDataSessionAt(fixture.root), program)).pipe(
      Effect.provide(
        Layer.mergeAll(
          originApprovalsLayer({ owners, platform: "darwin" }),
          RequestSends.layerAt(join(fixture.root, "requests.sqlite")).pipe(
            Layer.provide(Layer.succeed(TraceStore, fixture.store)),
            Layer.provide(
              Layer.succeed(
                TraceSessions,
                TraceSessions.of({
                  ...fixture.sessions,
                  session: () => fixture.sessions.session(TEST_SESSION),
                })
              )
            )
          )
        ).pipe(
          Layer.provideMerge(DataDatabase.layerAt(":memory:")),
          Layer.provideMerge(EventStore.layerSqlite(":memory:"))
        )
      )
    )
  );

/** The user answers an Origin Approval card. */
export const respond = (requestId: RequestId, scope: "reads" | "reads-and-writes") =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    yield* store.commit({
      commandId: null,
      decide: (model) =>
        Effect.succeed(
          decideSession(model.sessions.get(sessionId), {
            type: "approval.respond",
            requestId,
            decision: ApprovalDecision.cases.Allow.make({ remember: false, originScope: scope }),
            resolvedBy: "test",
          }).events
        ),
    });
  });
