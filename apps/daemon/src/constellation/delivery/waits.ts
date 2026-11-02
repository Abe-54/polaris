import type { AttemptId, HostId, SessionId, TurnId } from "@polaris/protocol";
import type { ConstellationRecord } from "../../store/constellation.ts";
import type { SessionRecord } from "../../store/model.ts";
import { latestAttempt } from "../projections.ts";
import { holds, workerWait } from "../waiting.ts";

export interface ExpiredWait {
  readonly attemptId: AttemptId;
  readonly sessionId: SessionId;
  /** The Turn the worker ended before its wait; the nudge acts only while it is still the last. */
  readonly turnId: TurnId;
}

/**
 * This Host's working workers whose wait ran out with no Turn since: the Harness never woke
 * them, so they get the silent end they would have had when their Turn ended (ENG-742).
 */
export const expiredWaits = (
  record: ConstellationRecord,
  sessions: ReadonlyMap<SessionId, SessionRecord>,
  hostId: HostId,
  now: number
): ReadonlyArray<ExpiredWait> =>
  record.graph.attempts.flatMap((attempt) => {
    const session = sessions.get(attempt.sessionId);
    const turn = session?.turns.at(-1);

    if (
      session === undefined ||
      turn === undefined ||
      attempt.hostId !== hostId ||
      attempt.sessionId === record.graph.leadSessionId ||
      latestAttempt(record.graph, attempt.taskId)?.id !== attempt.id
    )
      return [];
    const wait = workerWait(record, attempt, session);

    return wait === null || holds(wait, now)
      ? []
      : [{ attemptId: attempt.id, sessionId: attempt.sessionId, turnId: turn.id }];
  });
