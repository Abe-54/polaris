/**
 * Checkpoint pruning (`git/prune.ts`) as the engine drives it: the policy on
 * Archive, dropping a removed Workspace's checkpoints, and the periodic
 * sweeper's targets, built fresh from the read model for each sweep.
 */
import type { SessionId, TurnId, Workspace } from "@polaris/protocol";
import { dropCommittedRefs } from "../accept/commit.ts";
import { Clock, Context, Effect, Layer, Predicate } from "effect";
import {
  type CheckpointSession,
  DEFAULT_CHECKPOINT_POLICY,
  dropSessionCheckpoints,
  onSessionArchived as pruneArchivedSession,
  runCheckpointSweeper,
  type SweepTarget,
} from "../git/prune.ts";
import { finishingGit } from "../git/interrupt.ts";
import type { ServiceError } from "../services.ts";
import type { ReadModel, SessionRecord } from "../store/model.ts";
import { EngineRuntime } from "./runtime.ts";

/** The Turns each session's Forks started from, which survive compaction. */
const forkedTurns = (model: ReadModel): ReadonlyMap<SessionId, ReadonlyArray<TurnId>> => {
  const pinned = new Map<SessionId, Array<TurnId>>();

  for (const { session } of model.sessions.values()) {
    if (session.parentSessionId === null || session.forkedFromTurnId === null) continue;
    const list = pinned.get(session.parentSessionId) ?? [];
    list.push(session.forkedFromTurnId);
    pinned.set(session.parentSessionId, list);
  }

  return pinned;
};

/** Sessions with a Review Checkout of their Turns: pruned as if live, so the checkpoints stay. */
const underReview = (model: ReadModel): ReadonlySet<SessionId> =>
  new Set(
    [...model.reviewCheckouts.values()].flatMap(({ subject }) =>
      Predicate.isTagged(subject, "SessionTurns") ? [subject.sessionId] : []
    )
  );

const describeError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const make = (rt: EngineRuntime["Service"]): CheckpointPruning["Service"] => {
  const { store } = rt;
  const policy = rt.config.checkpointPolicy ?? DEFAULT_CHECKPOINT_POLICY;

  /**
   * What the pruning policy knows about one session. A session that is not
   * Archived keeps every checkpoint, so only an Archived one needs its Turn
   * order (`turnIds`, oldest first) and its Worktree's branch (read from SQL).
   */
  const checkpointSession = (
    record: SessionRecord,
    pinned: ReadonlyMap<SessionId, ReadonlyArray<TurnId>>,
    archivedAt: number | null,
    turnIds: ReadonlyArray<TurnId>
  ): Effect.Effect<CheckpointSession, ServiceError> =>
    Effect.gen(function* () {
      const session = record.session;

      const base = {
        sessionId: session.id,
        archivedAt,
        pinnedTurnIds: pinned.get(session.id) ?? [],
      };

      if (archivedAt === null) return base;

      const worktree =
        session.worktreeId === null ? null : yield* store.lastKnownWorktree(session.worktreeId);

      return {
        ...base,
        turnIds,
        worktreeBranch:
          worktree !== null && !worktree.isMain && worktree.createdBySessionId === session.id
            ? worktree.branch
            : null,
      };
    });

  /**
   * Every git Workspace with all its sessions. An Archived session's `updatedAt`
   * stands in for when it was Archived: a later change (a rename) only postpones its pruning.
   */
  const targets = Effect.gen(function* () {
    const model = yield* store.model;
    const pinned = forkedTurns(model);
    const reviewed = underReview(model);

    const archivedAt = ({ session }: SessionRecord) =>
      session.state === "archived" && !reviewed.has(session.id)
        ? Date.parse(session.updatedAt)
        : null;

    const swept = [...model.sessions.values()].filter(
      (r) => model.workspaces.get(r.session.workspaceId)?.isGitRepo === true
    );

    // One read for every Archived session's Turn order, not one per session.
    const turnIds = yield* store.readTurnIds(
      swept.flatMap((r) => (archivedAt(r) === null ? [] : [r.session.id]))
    );

    const found: Array<SweepTarget> = [];

    for (const workspace of model.workspaces.values()) {
      if (!workspace.isGitRepo) continue;

      const sessions = yield* Effect.forEach(
        swept.filter((r) => r.session.workspaceId === workspace.id),
        (record) =>
          checkpointSession(
            record,
            pinned,
            archivedAt(record),
            turnIds.get(record.session.id) ?? []
          )
      );

      found.push({ repoPath: workspace.path, sessions });
    }

    return found;
  });

  /** An archived session commits nothing more: its committed-Turn marks go (`accept/`). */
  const dropCommitted = (repoPath: string, sessionId: SessionId) =>
    finishingGit({
      try: () => dropCommittedRefs(repoPath, sessionId),
      catch: describeError,
    }).pipe(
      Effect.catch((message) =>
        Effect.logWarning(`dropping committed marks of ${sessionId}: ${message}`)
      )
    );

  const onArchived = (record: SessionRecord, workspace: Workspace, model: ReadModel) =>
    Effect.gen(function* () {
      yield* dropCommitted(workspace.path, record.session.id);

      if (underReview(model).has(record.session.id)) return;
      const at = yield* Clock.currentTimeMillis;
      const turnIds = yield* store.readTurnIds([record.session.id]);

      const session = yield* checkpointSession(
        record,
        forkedTurns(model),
        at,
        turnIds.get(record.session.id) ?? []
      );

      yield* pruneArchivedSession(workspace.path, session, { policy }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`checkpoint prune of ${record.session.id}: ${error.message}`)
        )
      );
    });

  const onWorkspaceRemoved = (workspace: Workspace, sessionIds: ReadonlyArray<SessionId>) =>
    Effect.forEach(
      sessionIds,
      (sessionId) =>
        finishingGit({
          try: () => dropSessionCheckpoints(workspace.path, sessionId),
          catch: describeError,
        }).pipe(
          Effect.catch((message) =>
            Effect.logWarning(`dropping checkpoints of ${sessionId}: ${message}`)
          ),
          Effect.andThen(dropCommitted(workspace.path, sessionId))
        ),
      { discard: true }
    );

  const interval = rt.config.checkpointSweepInterval;

  const startSweeper =
    interval === null
      ? Effect.void
      : Effect.forkIn(
          runCheckpointSweeper(
            interval === undefined ? { targets, policy } : { targets, policy, interval }
          ),
          rt.engineScope
        ).pipe(Effect.asVoid);

  return { onArchived, onWorkspaceRemoved, startSweeper };
};

export class CheckpointPruning extends Context.Service<
  CheckpointPruning,
  {
    /** Apply the policy to a session that was just Archived. */
    readonly onArchived: (
      record: SessionRecord,
      workspace: Workspace,
      model: ReadModel
    ) => Effect.Effect<void, ServiceError>;
    /** Nothing sweeps a removed Workspace's repository any more: drop its sessions' checkpoints. */
    readonly onWorkspaceRemoved: (
      workspace: Workspace,
      sessionIds: ReadonlyArray<SessionId>
    ) => Effect.Effect<void>;
    /** Fork the sweeper into the Engine's scope, unless it is turned off. */
    readonly startSweeper: Effect.Effect<void>;
  }
>()("polaris/daemon/engine/CheckpointPruning") {
  static readonly layer = Layer.effect(
    CheckpointPruning,
    Effect.gen(function* () {
      return make(yield* EngineRuntime);
    })
  );
}
