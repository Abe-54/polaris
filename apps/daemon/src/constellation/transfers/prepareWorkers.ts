import {
  type PermissionMode,
  type Attempt,
  type CommandId,
  type ConstellationCommand,
  type Constellation,
  type ConstellationRejected,
  type PreparedWorktree,
  type TaskDefinition,
  type WorktreeSetup,
  WorkerPlacement,
  RemotePlacementRequest,
  WorktreeRequest,
} from "@polaris/protocol";
import { Effect, Option, Predicate } from "effect";
import type { ReadModel } from "../../store/model.ts";
import { ConstellationWorktrees, gitOperation } from "../worktrees.ts";
import { isParent } from "../parents.ts";
import { workerMode } from "../permissionCeiling.ts";
import { latestAttempt, projectTask } from "../projections.ts";
import { finding, refusal } from "../decision.ts";
import { RemotePlacements } from "./placements.ts";
import { resolveCommit } from "../../git/git.ts";
import { leadRef } from "../leadCheckout.ts";
import type { ConstellationRecord } from "../../store/constellation.ts";

export interface WorkerPreparation {
  readonly key: string;
  readonly worktreeSetup?: WorktreeSetup | null;
  readonly forceSetup?: boolean;
  readonly graph: Constellation;
  readonly task: TaskDefinition;
  readonly placement: WorkerPlacement;
  readonly worktree: PreparedWorktree;
  readonly previous: Attempt | null;
  /** The ceiling when the Lead's Session lives on another Host. */
  readonly leadPermissionMode?: PermissionMode | null;
}

export interface WorkerPreparationHooks<R> {
  readonly defaultWorker: (graph: Constellation, task: TaskDefinition) => WorkerPlacement;
  /** L allocates/restores the Session and supplies selection/cause; this never submits a Turn. */
  readonly prepareSession: (
    input: WorkerPreparation
  ) => Effect.Effect<Attempt, ConstellationRejected, R>;
}

const requests = (command: ConstellationCommand, record: ConstellationRecord) => {
  if (Predicate.isTagged(command, "Dispatch"))
    return command.tasks.length > 0
      ? command.tasks
      : record.graph.tasks
          .filter(
            (task) =>
              !isParent(record.graph, task.id) && projectTask(record, task).state === "ready"
          )
          .map((t) => ({ taskId: t.id, worker: command.defaultWorker }));

  if (Predicate.isTagged(command, "Review") && Predicate.isTagged(command.action, "SendBack")) {
    const attempt = record.graph.attempts.find((a) => a.id === command.attemptId);

    return attempt === undefined ? [] : [{ taskId: attempt.taskId, worker: command.action.worker }];
  }

  return [];
};

interface PlacementInput {
  readonly key: string;
  readonly worktreeSetup?: WorktreeSetup | null;
  readonly forceSetup?: boolean;
  readonly graph: Constellation;
  readonly task: TaskDefinition;
  readonly placement: WorkerPlacement;
  readonly previous: Attempt | null;
  readonly leadPath: string;
  readonly model: ReadModel;
}

const fail = (input: PlacementInput, code: string, message: string) =>
  refusal(input.model.constellations.get(input.graph.id), [
    finding(
      code,
      message,
      "Reconnect the Desktop App, verify the placement and retry with the same command ID."
    ),
  ]);

const transferFailure =
  (input: PlacementInput) => (error: import("@polaris/protocol").ConstellationTransferError) =>
    fail(input, error.code, error.message);

const remotePlacement = (
  input: PlacementInput
): Extract<WorkerPlacement, { _tag: "New" }> | null => {
  if (Predicate.isTagged(input.placement, "New"))
    return input.placement.hostId === input.graph.hostId ? null : input.placement;

  if (
    input.previous?.sessionId === input.placement.sessionId &&
    input.previous.hostId !== input.graph.hostId
  )
    return WorkerPlacement.cases.New.make({ hostId: input.previous.hostId });

  return null;
};

const prepareRemote = Effect.fnUntraced(function* (
  input: PlacementInput,
  worker: Extract<WorkerPlacement, { _tag: "New" }>,
  baseHead: string
) {
  const keep = input.previous !== null && input.previous.hostId === worker.hostId;
  const remote = yield* RemotePlacements;

  return yield* remote
    .request(
      RemotePlacementRequest.make({
        id: input.key,
        graph: input.graph,
        task: input.task,
        baseHead,
        worktreeSetup: input.worktreeSetup ?? null,
        forceSetup: input.forceSetup ?? false,
        worker: WorkerPlacement.cases.New.make({
          ...worker,
          worktree: worker.worktree ?? (keep ? input.previous.worktree : null),
          branch: worker.branch ?? (keep ? input.previous.branch : null),
        }),
        sessionId: Predicate.isTagged(input.placement, "Existing")
          ? input.placement.sessionId
          : null,
        previous: input.previous,
        // An older remote Daemon can't decode plan; supervised is the same ceiling.
        leadPermissionMode: Option.match(
          Option.fromNullishOr(input.model.sessions.get(input.graph.leadSessionId)),
          { onNone: () => null, onSome: (lead) => workerMode(lead.session.permissionMode) }
        ),
      })
    )
    .pipe(Effect.mapError(transferFailure(input)));
});

const prepareLocal = Effect.fnUntraced(function* <R>(
  input: PlacementInput,
  base: string,
  hooks: WorkerPreparationHooks<R>
) {
  const placement = input.placement;

  const path = Predicate.isTagged(placement, "Existing")
    ? input.model.sessions.get(placement.sessionId)?.session.cwd
    : undefined;

  if (Predicate.isTagged(placement, "Existing") && path === undefined)
    return yield* fail(input, "E-SESSION", "The existing Session is unavailable on this Host");
  const previous = input.previous?.hostId === input.graph.hostId ? input.previous : null;
  const trees = yield* ConstellationWorktrees;

  const worktree = yield* trees
    .prepare(
      WorktreeRequest.make({
        key: input.key,
        constellationId: input.graph.id,
        task: input.task,
        repoPath: input.leadPath,
        leadPath: input.leadPath,
        branchPrefix: input.graph.settings.branchPrefix ?? "polaris",
        base,
        worktree:
          path ??
          (Predicate.isTagged(placement, "New") ? placement.worktree : null) ??
          previous?.worktree ??
          null,
        branch: Predicate.isTagged(placement, "New")
          ? (placement.branch ?? previous?.branch ?? null)
          : null,
      })
    )
    .pipe(Effect.mapError(transferFailure(input)));

  return yield* hooks.prepareSession({ ...input, worktree });
});

const prepareOne = Effect.fnUntraced(function* <R>(
  input: PlacementInput,
  hooks: WorkerPreparationHooks<R>
) {
  const trees = yield* ConstellationWorktrees;

  if (input.task.kind === "gate") {
    const worktree = yield* trees
      .gate(input.graph, input.leadPath)
      .pipe(Effect.mapError(transferFailure(input)));

    return yield* hooks.prepareSession({ ...input, worktree });
  }

  const base = Predicate.isTagged(input.placement, "New") ? input.placement.base : null;

  const baseHead = yield* gitOperation(() =>
    resolveCommit(input.leadPath, base ?? leadRef(input.graph))
  ).pipe(Effect.mapError(transferFailure(input)));

  if (baseHead === null) return yield* fail(input, "E-BASE", "The requested base is unavailable");
  const worker = remotePlacement(input);

  return yield* worker === null
    ? prepareLocal(input, baseHead, hooks)
    : prepareRemote(input, worker, baseHead);
});

/** Inject into Runtime.prepare; remote allocation waits for the Client, then E revalidates under commit. */
export const prepareWorkerAttempts = Effect.fnUntraced(function* <R>(
  command: ConstellationCommand,
  model: ReadModel,
  commandId: CommandId,
  hooks: WorkerPreparationHooks<R>
) {
  const record = model.constellations.get(command.constellationId);

  if (record === undefined) return [];
  const graph = record.graph;

  const forceSetup =
    Predicate.isTagged(command, "Review") &&
    Predicate.isTagged(command.action, "SendBack") &&
    command.action.mergeConflictBase !== null;

  const leadPath = model.sessions.get(graph.leadSessionId)?.session.cwd;

  if (leadPath === undefined)
    return yield* refusal(record, [
      finding("E-LEAD", "The Lead checkout is unavailable", "Restore the Lead Session."),
    ]);
  const attempts: Array<Attempt> = [];

  for (const request of requests(command, record)) {
    const task = graph.tasks.find((t) => t.id === request.taskId);

    if (task === undefined) continue;
    attempts.push(
      yield* prepareOne(
        {
          key: `${commandId}:${task.id}`,
          forceSetup,
          worktreeSetup: model.workspaces.get(graph.workspaceId)?.worktreeSetup ?? null,
          graph,
          task,
          leadPath,
          model,
          placement: request.worker ?? hooks.defaultWorker(graph, task),
          previous: latestAttempt(graph, task.id) ?? null,
        },
        hooks
      )
    );
  }

  return attempts;
});
