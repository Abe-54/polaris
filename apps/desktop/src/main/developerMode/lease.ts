/**
 * Polaris Dev's hold on Developer Mode (ENG-709, ADR 0095): a `developerMode.lease` on each
 * live connection to a Host that has it, so the Host traces without its setting being written.
 */
import { DEVELOPER_MODE_CAPABILITY, type DeveloperMode } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import type { LiveSession } from "@polaris/client";

/** What holding a lease reads of a live connection. */
export type LeaseSession = Pick<LiveSession, "capabilities"> & {
  readonly client: {
    readonly "developerMode.lease": (
      input: Record<string, never>
    ) => Stream.Stream<DeveloperMode, unknown>;
  };
};

/** Runs until interrupted: one lease per live connection; a lost one ends with it. */
export const holdDeveloperModeLease = (
  sessions: Stream.Stream<LeaseSession | null>
): Effect.Effect<void> =>
  sessions.pipe(
    Stream.switchMap((session) =>
      session === null || !session.capabilities.includes(DEVELOPER_MODE_CAPABILITY)
        ? Stream.empty
        : Stream.fromEffectDrain(
            Effect.ignore(Stream.runDrain(session.client["developerMode.lease"]({})))
          )
    ),
    Stream.runDrain
  );
