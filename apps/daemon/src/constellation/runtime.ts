import type {
  AttemptId,
  CommandId,
  ConstellationCommand,
  ConstellationRejected,
  EventEnvelope,
  HostId,
} from "@polaris/protocol";
import { Context, Effect } from "effect";
import type { ConstellationBinding, ConstellationContext } from "../engine/constellation.inputs.ts";
import type { ReadModel } from "../store/model.ts";

export type ConstellationPreparation = Pick<
  ConstellationContext,
  | "attempts"
  | "newLeadSessionId"
  | "claimProbe"
  | "recordedChecks"
  | "handoverDeferred"
  | "leadBranch"
>;

/** Worktree, Harness and delivery slices inject side effects through this boundary. */
export interface ConstellationRuntimeService {
  readonly prepare: (
    binding: ConstellationBinding,
    command: ConstellationCommand,
    model: ReadModel,
    commandId: CommandId
  ) => Effect.Effect<ConstellationPreparation, ConstellationRejected>;
  /** Reacquire folded working assignments after Session recovery, without sending a first Turn. */
  readonly resumeWorking: () => Effect.Effect<void>;
  /**
   * Restart a working Attempt's startup when it has no first Turn: reacquire its slot and send
   * the brief once. False when this Host doesn't run it or it already started.
   */
  readonly restartStartup?: (attemptId: AttemptId) => Effect.Effect<boolean>;
  readonly afterCommit: (
    binding: ConstellationBinding,
    command: ConstellationCommand,
    envelopes: ReadonlyArray<EventEnvelope>
  ) => Effect.Effect<void>;
}

export class ConstellationRuntime extends Context.Reference<ConstellationRuntimeService>(
  "polaris/daemon/constellation/Runtime",
  {
    defaultValue: () => ({
      prepare: () =>
        Effect.succeed({
          attempts: [],
          newLeadSessionId: null,
          claimProbe: null,
          recordedChecks: [],
        }),
      resumeWorking: () => Effect.void,
      afterCommit: () => Effect.void,
    }),
  }
) {}

export class ConstellationOwner extends Context.Service<ConstellationOwner, HostId>()(
  "polaris/daemon/constellation/Owner"
) {}
