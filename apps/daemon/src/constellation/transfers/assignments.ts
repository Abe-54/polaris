import {
  type Attempt,
  type AttemptId,
  type PreparedWorktree,
  type RemotePlacementRequest,
  RemoteWorkerAssignment,
  type ConstellationTransferError,
} from "@polaris/protocol";
import { Context, Effect, Layer } from "effect";
import { ConstellationOwner } from "../runtime.ts";
import { EventStore } from "../../store/EventStore.ts";
import { ConstellationWorktrees } from "../worktrees.ts";
import { TransferStorage } from "./storage.ts";
import { cleanupConstellationWorktrees, cleanupEligible } from "./cleanup.ts";
import { constellationRef } from "../../git/constellationBundles.ts";
import { samePath } from "../../git/WorktreeTracker.ts";
import { transferError } from "../worktrees.ts";
import { assignmentAttempt } from "./outbox.ts";

export interface RemoteWorkerHooks {
  /** Allocate/restore the Session through its machine; preparation must not start a Turn. */
  readonly prepare: (
    request: RemotePlacementRequest,
    prepared: PreparedWorktree
  ) => Effect.Effect<Attempt, ConstellationTransferError>;
  /** Start only after the owner has committed AttemptStarted; settled mirrors close working scopes. */
  readonly assigned: (
    assignment: RemoteWorkerAssignment
  ) => Effect.Effect<void, ConstellationTransferError>;
  /** After Session recovery, reacquire working scopes and rebuild attachments without a first Turn. */
  readonly claimed: (attemptId: AttemptId) => Effect.Effect<void>;
  readonly resume: (
    assignment: RemoteWorkerAssignment
  ) => Effect.Effect<void, ConstellationTransferError>;
  /** Start a stalled assigned worker's startup again; false when it isn't stalled here. */
  readonly restartStartup?: (attemptId: AttemptId) => Effect.Effect<boolean>;
}

export class RemoteWorkers extends Context.Reference<RemoteWorkerHooks>(
  "polaris/constellation/RemoteWorkers",
  {
    defaultValue: () => ({
      prepare: () =>
        Effect.fail(transferError("E-UNAVAILABLE", "Remote Session preparation is not mounted")),
      assigned: () => Effect.void,
      claimed: () => Effect.void,
      resume: () => Effect.void,
    }),
  }
) {}

export class RemoteAssignments extends Context.Service<
  RemoteAssignments,
  {
    readonly set: (
      assignment: RemoteWorkerAssignment
    ) => Effect.Effect<void, ConstellationTransferError>;
    readonly resumeWorking: () => Effect.Effect<void, ConstellationTransferError>;
  }
>()("polaris/constellation/RemoteAssignments") {
  static readonly layer = Layer.effect(
    RemoteAssignments,
    Effect.gen(function* () {
      const storage = yield* TransferStorage;
      const hooks = yield* RemoteWorkers;
      const hostId = yield* ConstellationOwner;

      const context = yield* Effect.context<
        EventStore | TransferStorage | ConstellationWorktrees
      >();

      return RemoteAssignments.of({
        set: Effect.fnUntraced(function* (assignment) {
          const attempt = assignment.graph.attempts.find((a) => a.id === assignment.attemptId);

          if (
            attempt === undefined ||
            attempt.hostId !== hostId ||
            assignment.graph.hostId === hostId
          )
            return yield* transferError(
              "E-AUTHORITY",
              "The assignment does not belong to this remote worker Host"
            );
          const assignments = yield* storage.assignments;
          const previous = assignments.find((a) => a.attemptId === assignment.attemptId);

          if (previous !== undefined) {
            const prior = assignmentAttempt(previous);

            if (
              prior.sessionId !== attempt.sessionId ||
              prior.hostId !== attempt.hostId ||
              prior.taskId !== attempt.taskId ||
              previous.graph.id !== assignment.graph.id
            )
              return yield* transferError("E-ASSIGNMENT", "An Attempt's identity cannot change");

            if (previous.graph.revision > assignment.graph.revision) return;
          }

          const placement = (yield* storage.placements).find((p) =>
            samePath(p.prepared.worktree, attempt.worktree)
          );

          const repoPath = placement?.prepared.repoPath ?? assignment.repoPath;
          yield* storage.assign(
            new RemoteWorkerAssignment({
              graph: assignment.graph,
              attemptId: assignment.attemptId,
              repoPath,
            })
          );
          // Persist before callback; an interrupted callback is retried by the next owner Snapshot.
          yield* hooks.assigned(assignment);

          if (cleanupEligible(assignment.graph))
            yield* cleanupConstellationWorktrees(
              assignment.graph,
              repoPath,
              constellationRef(assignment.graph.id, null)
            ).pipe(Effect.provide(context));
        }),
        resumeWorking: Effect.fnUntraced(function* () {
          for (const assignment of yield* storage.assignments) {
            if (
              (assignmentAttempt(assignment).state === "working" ||
                assignmentAttempt(assignment).state === "blocked") &&
              assignment.graph.state !== "completed" &&
              assignment.graph.state !== "archived"
            )
              yield* hooks.resume(assignment);
          }
        }),
      });
    })
  );
}
