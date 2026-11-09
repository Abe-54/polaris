/**
 * A steer the Harness refused after the Engine accepted it (ENG-797): its Turn records the
 * user's text and why it didn't go in, as for a refused deferred prompt (`session.deferred.ts`).
 */
import {
  type Attachment,
  DomainEvent,
  type SessionId,
  type TurnId,
  TurnItem,
} from "@polaris/protocol";
import { Effect } from "effect";
import { HarnessError } from "../harness/HarnessDriver.ts";
import { steerItem } from "../harness/userMessage.ts";
import type { EngineRuntime } from "./runtime.ts";

export interface RefusedSteer {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
}

/** The Error item's copy; the reason is the Harness's own. */
export const steerRefusalMessage = (reason: string) =>
  `This message didn't reach the agent: ${reason}`;

/** `refused:`/`refusal:` ids are the Daemon-recorded items `HInputRefused` maps in the spec. */
export const steerRefusalEvents = (steer: RefusedSteer, reason: string) => {
  const id = crypto.randomUUID();

  return [
    DomainEvent.cases.TurnItemCompleted.make({
      sessionId: steer.sessionId,
      turnId: steer.turnId,
      subagentId: null,
      item: steerItem(`refused:${id}`, steer.text, steer.attachments),
    }),
    DomainEvent.cases.TurnItemCompleted.make({
      sessionId: steer.sessionId,
      turnId: steer.turnId,
      subagentId: null,
      item: TurnItem.cases.Error.make({
        id: `refusal:${id}`,
        message: steerRefusalMessage(reason),
      }),
    }),
  ];
};

/**
 * Runs `steered`; if the Harness refuses it without recording that itself, the Turn records
 * the steer and the refusal, then the error still fails the reaction (and is logged).
 */
export const recordRefusedSteer = (
  rt: EngineRuntime["Service"],
  steer: RefusedSteer | null,
  steered: Effect.Effect<void, HarnessError>
) =>
  steered.pipe(
    Effect.catchTag("HarnessError", (error) =>
      steer === null || error.recorded === true
        ? Effect.fail(error)
        : rt
            .recordFor(steer.sessionId, () => steerRefusalEvents(steer, error.message))
            .pipe(Effect.andThen(Effect.fail(error)))
    )
  );

/** No live Harness to take the steer: refused like any other. */
export const noHarness = (harness: string) =>
  new HarnessError({ harness, message: "the agent isn't running" });
