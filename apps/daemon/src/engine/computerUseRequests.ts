/**
 * Computer use requests (ENG-846): an agent's `request_computer_use` opens a `computer-use`
 * approval on its Turn in flight and waits. The Daemon withdraws it once the Host is Ready, then
 * stops the Harness after that Turn, so the next Turn reopens it with polaris_desktop's tools.
 */
import {
  ApprovalRequest,
  ComputerUseRequest,
  type DomainEvent,
  RequestId,
  type SessionId,
} from "@polaris/protocol";
import { Context, Effect, Layer, Match, Option, Predicate, Stream } from "effect";
import {
  type ComputerUseAsk,
  ComputerUseOutcome,
  type RequestComputerUse,
} from "../harness/desktop/service.ts";
import { workingTurn } from "../store/model.ts";
import { EngineRuntime } from "./runtime.ts";

/** The withdrawal reasons the outcome is read back from. */
export const COMPUTER_USE_ON = "Computer use is on";

export const COMPUTER_USE_TIMED_OUT = "The request timed out";

const outcomeOf = (event: DomainEvent | undefined): ComputerUseOutcome =>
  Match.value(event).pipe(
    Match.tag("ApprovalResolved", ({ decision }) =>
      Predicate.isTagged(decision, "Deny")
        ? ComputerUseOutcome.NotNow()
        : ComputerUseOutcome.Ended({ reason: "It was answered" })
    ),
    Match.tag("ApprovalWithdrawn", ({ reason }) =>
      Match.value(reason).pipe(
        Match.when(COMPUTER_USE_ON, () => ComputerUseOutcome.Ready()),
        Match.when(COMPUTER_USE_TIMED_OUT, () => ComputerUseOutcome.TimedOut()),
        Match.orElse(() => ComputerUseOutcome.Ended({ reason }))
      )
    ),
    Match.orElse(() => ComputerUseOutcome.Ended({ reason: "The request ended" }))
  );

export class ComputerUseRequests extends Context.Service<
  ComputerUseRequests,
  {
    /** Opens a request on the session's Turn in flight and waits for its outcome. */
    readonly request: RequestComputerUse;
  }
>()("polaris/daemon/engine/ComputerUseRequests") {
  static readonly layer = Layer.effect(
    ComputerUseRequests,
    Effect.gen(function* () {
      return make(yield* EngineRuntime);
    })
  );
}

const make = (rt: EngineRuntime["Service"]): ComputerUseRequests["Service"] => {
  const pending = (sessionId: SessionId, requestId: RequestId) =>
    Effect.map(
      rt.store.model,
      (model) => model.sessions.get(sessionId)?.pending.has(requestId) ?? false
    );

  const withdraw = (sessionId: SessionId, requestId: RequestId, reason: string) =>
    Effect.ignore(
      rt.signal(sessionId, {
        type: "harness.approvalWithdrawn",
        requestId,
        withdrawnBy: "daemon",
        reason,
      })
    );

  const closing = Effect.fnUntraced(function* (
    sessionId: SessionId,
    requestId: RequestId,
    after: number
  ) {
    const model = yield* rt.store.model;

    const events = yield* rt.store.readEvents({
      after,
      upTo: model.sequence ?? after,
      sessionId,
      eventTypes: ["ApprovalResolved", "ApprovalWithdrawn"],
    });

    return events
      .map((envelope) => envelope.event)
      .find(
        (event) =>
          (Predicate.isTagged(event, "ApprovalResolved") ||
            Predicate.isTagged(event, "ApprovalWithdrawn")) &&
          event.requestId === requestId
      );
  });

  /** After the Turn the request was on ends, the Harness stops; the next Turn reopens it. */
  const reopenAfterTurn = Effect.fnUntraced(function* (sessionId: SessionId) {
    const ends = yield* rt.store.subscribe({
      sessionId,
      filter: (item) =>
        Predicate.isTagged(item, "Event") && Predicate.isTagged(item.envelope.event, "TurnEnded"),
    });

    yield* Stream.runHead(ends);
    yield* rt.serially(sessionId)(
      Effect.andThen(rt.cancelIdle(sessionId), rt.stopHarness(sessionId))
    );
  });

  const wait = Effect.fnUntraced(function* (
    sessionId: SessionId,
    requestId: RequestId,
    ask: ComputerUseAsk
  ) {
    const commits = yield* rt.store.subscribe({ sessionId });
    const record = (yield* rt.store.model).sessions.get(sessionId);

    if (record === undefined) return ComputerUseOutcome.NotFound();
    const turn = workingTurn(record);

    if (turn === undefined) return ComputerUseOutcome.NoTurn();
    const openedAt = yield* rt.now;

    const opened = yield* rt.signal(sessionId, {
      type: "harness.approvalRequested",
      request: new ApprovalRequest({
        id: requestId,
        sessionId,
        turnId: turn.id,
        kind: "computer-use",
        computerUse: ComputerUseRequest.make({
          state: ask.state,
          app: ask.app,
          reason: ask.reason,
        }),
        title: `Use ${ask.app}`,
        detail: ask.reason,
        options: [],
        questions: [],
        expiresAt: new Date(Date.parse(openedAt) + ask.timeoutMs).toISOString(),
        openedAt,
      }),
    });

    if (!Predicate.isTagged(opened, "Committed") || opened.sequence === null)
      return ComputerUseOutcome.NoTurn();
    const after = opened.sequence;

    const answered = commits.pipe(
      Stream.mapEffect(() => Effect.map(pending(sessionId, requestId), (still) => !still)),
      Stream.takeUntil((done) => done),
      Stream.runDrain
    );

    const ready = Effect.andThen(ask.ready, withdraw(sessionId, requestId, COMPUTER_USE_ON));
    const settled = yield* Effect.timeoutOption(Effect.raceFirst(answered, ready), ask.timeoutMs);

    if (Option.isNone(settled) && (yield* pending(sessionId, requestId)))
      yield* withdraw(sessionId, requestId, COMPUTER_USE_TIMED_OUT);
    const outcome = outcomeOf(yield* closing(sessionId, requestId, after));

    if (Predicate.isTagged(outcome, "Ready"))
      yield* Effect.forkIn(Effect.scoped(reopenAfterTurn(sessionId)), rt.engineScope);

    return outcome;
  });

  return {
    request: (sessionId, ask) =>
      Effect.suspend(() => {
        const requestId = RequestId.make(`computer-use-${crypto.randomUUID()}`);

        return Effect.scoped(wait(sessionId, requestId, ask)).pipe(
          // A call the agent abandons withdraws its request.
          Effect.onInterrupt(() => withdraw(sessionId, requestId, "The agent stopped waiting")),
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning(`session ${sessionId}: computer use request failed`, cause),
              ComputerUseOutcome.Ended({ reason: "The request couldn't be recorded" })
            )
          )
        );
      }),
  };
};
