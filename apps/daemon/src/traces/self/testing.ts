/** A settable Developer Mode for Self-Trace tests. */
import { DeveloperMode, type WorkspaceId } from "@polaris/protocol";
import { Effect, Layer, SubscriptionRef } from "effect";
import { DeveloperModeState } from "../../developerMode/service.ts";

/** A valid Developer Mode: `effective` follows from the rest, as the Host derives it. */
export const developerMode = (
  options: {
    readonly stored?: boolean;
    readonly leases?: number;
    readonly fromSource?: boolean;
    readonly polarisWorkspaceId?: WorkspaceId | null;
  } = {}
) => {
  const stored = options.stored ?? false;
  const leases = options.leases ?? 0;
  const fromSource = options.fromSource ?? false;
  const polarisWorkspaceId = options.polarisWorkspaceId ?? null;

  return DeveloperMode.make({
    stored,
    leases,
    fromSource,
    effective: stored || leases > 0 || fromSource,
    polarisWorkspaceId,
    polarisWorkspaceSource: polarisWorkspaceId === null ? null : "remote",
  });
};

/** `set` publishes to every `changes` subscriber, as the live Layer does. */
export const makeTestDeveloperMode = Effect.fnUntraced(function* (
  initial: DeveloperMode = developerMode()
) {
  const ref = yield* SubscriptionRef.make(initial);

  const state = DeveloperModeState.of({
    current: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref),
  });

  return {
    layer: Layer.succeed(DeveloperModeState, state),
    set: (mode: DeveloperMode) => SubscriptionRef.set(ref, mode),
  };
});
