/** The domain events the Session machine builds from a folded record. */
import {
  DomainEvent,
  type SessionId,
  type SessionState,
  type Turn,
  type TurnId,
} from "@polaris/protocol";
import { foldSession, patchTurn, type SessionRecord } from "../store/model.ts";

export const stateChanged = (
  sessionId: SessionId,
  state: SessionState,
  reason: string | null = null,
  resetsAt: string | null = null
): DomainEvent =>
  state === "limited"
    ? DomainEvent.cases.SessionStateChanged.make({ sessionId, state, reason, resetsAt })
    : DomainEvent.cases.SessionStateChanged.make({ sessionId, state, reason });

export const endTurn = (
  turn: Turn,
  status: "completed" | "interrupted" | "failed",
  endedAt: string,
  checkpoint: { readonly ref: string; readonly commit: string } | null = null
): DomainEvent =>
  DomainEvent.cases.TurnEnded.make({
    turn: patchTurn(
      turn,
      checkpoint === null
        ? { status, endedAt }
        : {
            status,
            endedAt,
            checkpointAfter: checkpoint.ref,
            checkpointAfterCommit: checkpoint.commit,
          }
    ),
  });

export const withdrawPending = (
  record: SessionRecord,
  withdrawnBy: "harness" | "daemon",
  reason: string,
  onlyTurn?: TurnId
): Array<DomainEvent> =>
  [...record.pending.values()].flatMap((request) =>
    onlyTurn === undefined || request.turnId === onlyTurn
      ? [
          DomainEvent.cases.ApprovalWithdrawn.make({
            sessionId: record.session.id,
            requestId: request.id,
            withdrawnBy,
            reason,
          }),
        ]
      : []
  );

export const RECOVERY_REASON = {
  restart: "The Daemon restarted",
  upgrade: "The Daemon is upgrading",
} as const;

/** The event with its Turn as `record` folded it: with its user-Turn number and reply preview. */
const asFolded = (event: DomainEvent, record: SessionRecord | undefined): DomainEvent => {
  const folded = (turn: Turn) => record?.turns.find((t) => t.id === turn.id) ?? turn;

  return DomainEvent.matchOrElse(
    event,
    {
      TurnStarted: ({ turn }) => DomainEvent.cases.TurnStarted.make({ turn: folded(turn) }),
      TurnEnded: ({ turn }) => DomainEvent.cases.TurnEnded.make({ turn: folded(turn) }),
    },
    () => event
  );
};

/** Events as the Session machine emits them, and the record they fold to. */
export interface FoldedEvents {
  readonly events: ReadonlyArray<DomainEvent>;
  readonly record: SessionRecord | undefined;
}

/** Fold `events` into `record` one by one; each Turn event carries what the fold derived for it. */
export const foldEach = (
  sessionId: SessionId,
  record: SessionRecord | undefined,
  events: ReadonlyArray<DomainEvent>
): FoldedEvents => {
  let next = record;

  const stamped = events.map((event) => {
    next = foldSession(sessionId, next, [event], "");

    return asFolded(event, next);
  });

  return { events: stamped, record: next };
};
