/**
 * Computer use approvals (ADR 0104): `polaris_desktop` opens an approval of kind `app` or
 * `headed-input` on the session's Turn in flight and waits for the user's answer. They go
 * through the Session machine like any request; no Harness and no permission mode sees them.
 */
import {
  type AppApprovalKind,
  type ApprovalDecision,
  ApprovalRequest,
  type DesktopApp,
  RequestId,
  type SessionId,
} from "@polaris/protocol";
import { Context, Effect, Layer, Predicate, Stream } from "effect";
import type { ServiceError } from "../services.ts";
import { workingTurn } from "../store/model.ts";
import { EngineRuntime } from "./runtime.ts";

export interface AppApprovalInput {
  readonly kind: AppApprovalKind;
  readonly app: DesktopApp;
  readonly title: string;
  readonly detail: string | null;
}

export class AppApprovals extends Context.Service<
  AppApprovals,
  {
    /**
     * Opens the approval and waits. The user's decision, or null when it closed unanswered:
     * no Turn in flight, or the Turn ended first. Interrupting it withdraws the approval.
     */
    readonly request: (
      sessionId: SessionId,
      input: AppApprovalInput
    ) => Effect.Effect<ApprovalDecision | null, ServiceError>;
  }
>()("polaris/daemon/engine/AppApprovals") {
  static readonly layer = Layer.effect(
    AppApprovals,
    Effect.map(EngineRuntime, (rt) => make(rt))
  );
}

const make = (rt: EngineRuntime["Service"]): AppApprovals["Service"] => {
  const pending = (sessionId: SessionId, requestId: RequestId) =>
    Effect.map(
      rt.store.model,
      (model) => model.sessions.get(sessionId)?.pending.has(requestId) ?? false
    );

  /** The decision that closed the request, read from the log after it opened. */
  const decided = Effect.fnUntraced(function* (
    sessionId: SessionId,
    requestId: RequestId,
    after: number
  ) {
    const model = yield* rt.store.model;

    const events = yield* rt.store.readEvents({
      after,
      upTo: model.sequence ?? after,
      sessionId,
      eventTypes: ["ApprovalResolved"],
    });

    for (const { event } of events)
      if (Predicate.isTagged(event, "ApprovalResolved") && event.requestId === requestId)
        return event.decision;

    return null;
  });

  const wait = Effect.fnUntraced(function* (
    sessionId: SessionId,
    requestId: RequestId,
    input: AppApprovalInput
  ) {
    const commits = yield* rt.store.subscribe({ sessionId });
    const record = (yield* rt.store.model).sessions.get(sessionId);
    const turn = record === undefined ? undefined : workingTurn(record);

    if (turn === undefined) return null;

    const opened = yield* rt.signal(sessionId, {
      type: "harness.approvalRequested",
      request: new ApprovalRequest({
        id: requestId,
        sessionId,
        turnId: turn.id,
        kind: input.kind,
        title: input.title,
        detail: input.detail,
        options: [],
        questions: [],
        app: input.app,
        openedAt: yield* rt.now,
      }),
    });

    if (!Predicate.isTagged(opened, "Committed") || opened.sequence === null) return null;

    if (yield* pending(sessionId, requestId))
      yield* commits.pipe(
        Stream.mapEffect(() => pending(sessionId, requestId)),
        Stream.takeUntil((still) => !still),
        Stream.runDrain
      );

    return yield* decided(sessionId, requestId, opened.sequence);
  });

  return {
    request: (sessionId, input) =>
      Effect.suspend(() => {
        const requestId = RequestId.make(`app-${crypto.randomUUID()}`);

        return Effect.scoped(wait(sessionId, requestId, input)).pipe(
          // A tool call the agent abandons withdraws its approval.
          Effect.onInterrupt(() =>
            Effect.ignore(
              rt.signal(sessionId, {
                type: "harness.approvalWithdrawn",
                requestId,
                withdrawnBy: "daemon",
                reason: "The agent stopped waiting",
              })
            )
          )
        );
      }),
  };
};
