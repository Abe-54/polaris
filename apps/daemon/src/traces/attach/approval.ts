import { ApprovalRequest, ProfileError, RequestId, type SessionId } from "@polaris/protocol";
import { Effect, Option, Predicate, Stream } from "effect";
import { EventStore } from "../../store/EventStore.ts";
import { workingTurn } from "../../store/model.ts";
import { decideSession } from "../../engine/session.ts";
import { redactText } from "../redact.ts";

export const attachDenied = (message: string) =>
  new ProfileError({
    code: "E-PROFILE-ATTACH-DENIED",
    message,
    fix: "Request a new profile from a writable agent session and approve it in Polaris.",
  });

/** Every invocation opens a fresh card. Only an explicit, unremembered user Allow can release it. */
export const approveAttach = Effect.fnUntraced(function* (
  sessionId: SessionId,
  target: NonNullable<ApprovalRequest["profileAttach"]>
) {
  const store = yield* EventStore;
  const id = RequestId.make(`profile-attach-${crypto.randomUUID()}`);

  const subscription = yield* store.subscribe({
    filter: (item) =>
      Predicate.isTagged(item, "Event") &&
      (Predicate.isTagged(item.envelope.event, "ApprovalResolved") ||
        Predicate.isTagged(item.envelope.event, "ApprovalWithdrawn")) &&
      item.envelope.event.requestId === id,
  });

  let opened = false;
  let approvedTurn: import("@polaris/protocol").TurnId | undefined;
  yield* Effect.addFinalizer(() =>
    store
      .commit({
        commandId: null,
        decide: (model) => {
          const record = model.sessions.get(sessionId);

          if (!record?.pending.has(id)) return Effect.succeed([]);

          return Effect.succeed(
            decideSession(record, {
              type: "harness.approvalWithdrawn",
              requestId: id,
              withdrawnBy: "daemon",
              reason: "The profile request ended before approval.",
            }).events
          );
        },
      })
      .pipe(Effect.ignore)
  );
  yield* store
    .commit({
      commandId: null,
      decide: (model) => {
        const record = model.sessions.get(sessionId);
        const turn = record && workingTurn(record);

        if (!record || !turn) return Effect.succeed([]);
        approvedTurn = turn.id;
        const command = redactText(target.command);

        const request = new ApprovalRequest({
          id,
          sessionId,
          turnId: turn.id,
          kind: "tool",
          profileAttach: { ...target, command },
          title: `Profile Node process ${target.pid} for ${target.seconds} s`,
          detail: `${command}\npid ${target.pid} · Node · profile for ${target.seconds} s\nwhile attached, any local process can run code in it`,
          options: [],
          questions: [],
          openedAt: new Date().toISOString(),
        });

        const decision = decideSession(record, { type: "inspector.approvalRequested", request });
        opened = decision.events.some((e) => Predicate.isTagged(e, "ApprovalRequested"));

        return Effect.succeed(decision.events);
      },
    })
    .pipe(Effect.mapError(() => attachDenied("The approval could not be recorded.")));

  if (!opened) return yield* attachDenied("There is no active turn for this approval.");
  const answer = yield* subscription.pipe(Stream.runHead, Effect.timeoutOption("5 minutes"));

  if (Option.isNone(answer) || Option.isNone(answer.value))
    return yield* attachDenied("The profile approval expired.");
  const item = answer.value.value;

  if (!Predicate.isTagged(item, "Event"))
    return yield* attachDenied("The profile was not approved.");
  const event = item.envelope.event;

  if (
    !Predicate.isTagged(event, "ApprovalResolved") ||
    !Predicate.isTagged(event.decision, "Allow") ||
    event.decision.remember
  )
    return yield* attachDenied("The user denied or withdrew the profile request.");

  return approvedTurn!;
});
