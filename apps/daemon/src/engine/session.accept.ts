/**
 * The session machine's rule for accepting Turns (`AcceptTurns`, ENG-224):
 * a contiguous prefix, only between Turns, never moving backwards. Accepting
 * changes no Session State.
 */
import { DomainEvent } from "@polaris/protocol";
import { Result } from "effect";
import { type SessionRecord, workingTurn } from "../store/model.ts";
import type { SessionInput } from "./session.inputs.ts";

/** The last Turn is accepted, so Continue may not reopen it (spec: `acceptedNeverInFlight`). */
export const lastIsAccepted = (record: SessionRecord): boolean => {
  const accepted = record.session.acceptedThroughIndex;
  const last = record.turns.at(-1);

  return accepted !== null && last !== undefined && last.index <= accepted;
};

type AcceptInput = Extract<SessionInput, { type: "turns.accept" }>;

/** The events accepting through `event`'s Turn records, or why it is refused. */
export const acceptTurns = (
  record: SessionRecord,
  event: AcceptInput
): Result.Result<ReadonlyArray<DomainEvent>, string> => {
  const accepted = record.session.acceptedThroughIndex;

  if (workingTurn(record) !== undefined || event.status === "working") {
    return Result.fail("the session is working; wait for the Turn to end");
  }

  if (accepted !== null && event.index < accepted) {
    return Result.fail(`the Turns through Turn ${accepted + 1} are already accepted`);
  }

  if (accepted === event.index && !event.revertLaterTurns) return Result.succeed([]);

  return Result.succeed([
    DomainEvent.cases.TurnsAccepted.make({
      sessionId: record.session.id,
      throughTurnId: event.turnId,
      throughIndex: event.index,
      throughUserTurn: event.userTurnNumber ?? null,
      revertLaterTurns: event.revertLaterTurns,
      acceptedBy: event.acceptedBy,
    }),
  ]);
};
