import type { Attempt, PreparedWorktree, Constellation, DomainEvent } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { samePath } from "../../git/WorktreeTracker.ts";
import { EventStore } from "../../store/EventStore.ts";
import { ConstellationWorktrees } from "../worktrees.ts";
import { leadRef } from "../leadCheckout.ts";
import { TransferStorage } from "./storage.ts";

export const cleanupEligible = (graph: Constellation) =>
  graph.state === "archived" ||
  graph.tasks.some(
    (task) =>
      task.kind === "gate" &&
      graph.attempts.findLast((a) => a.taskId === task.id)?.state === "accepted"
  );

/** Run after working scopes close; remote callers supply the fetched owner head reference. */
export const cleanupConstellationWorktrees = Effect.fnUntraced(function* (
  graph: Constellation,
  leadPath: string,
  mergedRef: string = leadRef(graph)
) {
  if (!cleanupEligible(graph)) return;
  const storage = yield* TransferStorage;
  const worktrees = yield* ConstellationWorktrees;
  const store = yield* EventStore;
  const model = yield* store.model;

  const busy = new Set(
    [...model.sessions.values()].flatMap((s) =>
      s.session.state !== "idle" && s.session.state !== "archived" ? [s.session.id] : []
    )
  );

  const candidates: Array<{ attempt: Attempt; prepared: PreparedWorktree }> = [];

  for (const placement of yield* storage.placements) {
    if (placement.removed) continue;

    const attempt = graph.attempts.findLast((a) =>
      samePath(a.worktree, placement.prepared.worktree)
    );

    if (
      attempt !== undefined &&
      !candidates.some((c) => samePath(c.prepared.worktree, placement.prepared.worktree))
    )
      candidates.push({ attempt, prepared: placement.prepared });
  }

  return yield* worktrees.cleanup(graph, leadPath, candidates, busy, mergedRef);
});

export const cleanupCommittedWorktrees = Effect.fnUntraced(function* (
  events: ReadonlyArray<DomainEvent>
) {
  const ids = new Set(
    events.flatMap((e) =>
      Predicate.isTagged(e, "AttemptAccepted") || Predicate.isTagged(e, "ConstellationStateChanged")
        ? [e.constellationId]
        : []
    )
  );

  const store = yield* EventStore;
  const model = yield* store.model;

  for (const id of ids) {
    const graph = model.constellations.get(id)?.graph;

    const path =
      graph === undefined ? undefined : model.sessions.get(graph.leadSessionId)?.session.cwd;

    if (graph !== undefined && path !== undefined)
      yield* cleanupConstellationWorktrees(graph, path);
  }
});
