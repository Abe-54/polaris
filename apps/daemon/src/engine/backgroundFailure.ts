/**
 * An accepted `BackgroundCommand` the live Harness couldn't carry out (ENG-389): recorded as
 * `SessionBackgroundCommandFailed`, which the Desktop App shows as "Couldn't run in background".
 */
import { DomainEvent, type SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import type { HarnessError } from "../harness/HarnessDriver.ts";
import type { EngineRuntime } from "./runtime.ts";

/** The reason when the Harness found nothing to move: the command ended before it got there. */
export const nothingMovedReason = (itemId: string | null): string =>
  itemId === null ? "every command had already finished" : "the command already finished";

/** The Harness's own words when it has them ("background tasks are disabled"). */
export const refusedReason = (error: HarnessError): string =>
  error.cause instanceof Error && error.cause.message !== "" ? error.cause.message : error.message;

export const recordBackgroundFailure = (
  rt: EngineRuntime["Service"],
  sessionId: SessionId,
  itemId: string | null,
  reason: string
) =>
  Effect.logWarning(`${sessionId}: couldn't run ${itemId ?? "commands"} in the background`).pipe(
    Effect.annotateLogs({ reason }),
    Effect.andThen(
      rt.recordFor(sessionId, () => [
        DomainEvent.cases.SessionBackgroundCommandFailed.make({ sessionId, itemId, reason }),
      ])
    ),
    Effect.asVoid
  );
