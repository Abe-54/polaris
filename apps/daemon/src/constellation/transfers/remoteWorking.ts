import {
  CommandId,
  type DomainEvent,
  type Attempt,
  type AttemptId,
  type RemoteWorkerAssignment,
  type ConstellationTransferError,
} from "@polaris/protocol";
import { Effect, Exit, Layer, Scope, Predicate, Stream, SubscriptionRef } from "effect";
import type { StartupAbandoned } from "../composition/startupAbandoned.ts";
import { EventStore } from "../../store/EventStore.ts";
import {
  cancelWorkerAdmissionWait,
  registerWorkerAdmission,
  registerWorkerAdmissionSource,
  workerBusy,
} from "../../resources/workerAdmission.ts";
import { HostResources } from "../../resources/index.ts";
import { McpTokens } from "../../mcp/index.ts";
import { ConstellationOwner } from "../runtime.ts";
import { workerEnvironment, type WorkerEnvironment } from "../host.ts";
import { TransferStorage } from "./storage.ts";
import { RemoteWorkers, type RemoteWorkerHooks } from "./assignments.ts";
import { assignmentAttempt } from "./outbox.ts";

export interface RemoteWorkingHooks<E, R> {
  readonly prepare: RemoteWorkerHooks["prepare"];
  readonly start: (
    assignment: RemoteWorkerAssignment,
    env: Readonly<WorkerEnvironment>
  ) => Effect.Effect<void, E | StartupAbandoned, R>;
  readonly resume: (
    assignment: RemoteWorkerAssignment,
    env: Readonly<WorkerEnvironment>
  ) => Effect.Effect<void, E | StartupAbandoned, R>;
  readonly failed: (
    attempt: Attempt,
    error: E | ConstellationTransferError | import("@polaris/protocol").ResourceError
  ) => Effect.Effect<void, never, R>;
}

const retainsAssignment = (attempt: Attempt) =>
  attempt.state === "working" || attempt.state === "blocked";

/** Worker assignments follow remote mirrors and locally queued Claims, without committing owner events here. */
export const remoteWorkingAttemptsLayer = <E, R>(hooks: RemoteWorkingHooks<E, R>) =>
  Layer.effect(
    RemoteWorkers,
    Effect.gen(function* () {
      const store = yield* EventStore;
      const resources = yield* HostResources;
      const tokens = yield* McpTokens;
      const storage = yield* TransferStorage;
      const hostId = yield* ConstellationOwner;
      const parent = yield* Effect.scope;
      const context = yield* Effect.context<R>();
      yield* registerWorkerAdmissionSource(
        store,
        parent,
        (sessionId) =>
          Effect.gen(function* () {
            const assignments = yield* storage.assignmentsForSession(sessionId);

            if (assignments.length === 0) return false;
            const claimed = yield* storage.claimedAttempts.pipe(Effect.orDie);

            return (yield* storage.assignmentsForSession(sessionId)).some((assignment) => {
              const attempt = assignmentAttempt(assignment);

              return (
                attempt.sessionId === sessionId &&
                attempt.hostId === hostId &&
                retainsAssignment(attempt) &&
                !claimed.has(attempt.id) &&
                assignment.graph.state !== "completed" &&
                assignment.graph.state !== "archived" &&
                assignment.graph.attempts.findLast((a) => a.taskId === attempt.taskId)?.id ===
                  attempt.id
              );
            });
          }),
        (sessionId) => storage.hasAssignmentsForSession?.(sessionId) !== false
      );
      const started = new Set<AttemptId>();

      const working = new Map<
        AttemptId,
        {
          scope: Scope.Closeable;
          suspend: Effect.Effect<void>;
          observe: (event: DomainEvent) => Effect.Effect<void>;
        }
      >();

      const stop = Effect.fnUntraced(function* (id: AttemptId) {
        const entry = working.get(id);
        working.delete(id);

        if (entry !== undefined) yield* Scope.close(entry.scope, Exit.void);

        const assignment = (yield* storage.assignments.pipe(Effect.orDie)).find(
          (a) => a.attemptId === id
        );

        if (assignment !== undefined)
          yield* cancelWorkerAdmissionWait(store, assignmentAttempt(assignment).sessionId);
      });

      const start = Effect.fnUntraced(function* (
        assignment: RemoteWorkerAssignment,
        resume: boolean
      ) {
        const attempt = assignmentAttempt(assignment);
        const latest = assignment.graph.attempts.findLast((a) => a.taskId === attempt.taskId);

        if (
          attempt.hostId !== hostId ||
          !retainsAssignment(attempt) ||
          latest?.id !== attempt.id ||
          assignment.graph.state === "completed" ||
          assignment.graph.state === "archived"
        ) {
          yield* stop(attempt.id);

          if (
            (attempt.state !== "review" && attempt.state !== "blocked") ||
            assignment.graph.state === "archived"
          )
            yield* tokens.revokeAttempt(attempt.id).pipe(Effect.orDie);

          return;
        }

        if ((yield* storage.claimedAttempts).has(attempt.id)) {
          yield* stop(attempt.id);

          return;
        }

        const existing = working.get(attempt.id);

        if (existing !== undefined) {
          yield* existing.suspend;

          return;
        }

        const scope = yield* Scope.fork(parent);

        const currentAssignment = Effect.map(
          storage.assignments.pipe(Effect.orDie),
          (assignments) =>
            assignments.find(
              (a) =>
                a.attemptId === assignment.attemptId &&
                a.graph.id === assignment.graph.id &&
                a.graph.hostId === assignment.graph.hostId &&
                assignmentAttempt(a).sessionId === attempt.sessionId
            )
        );

        let abandoned = false;

        const mayRelease = Effect.gen(function* () {
          const current = yield* currentAssignment;

          return (
            current !== undefined &&
            (abandoned || assignmentAttempt(current).state === "blocked") &&
            !workerBusy((yield* store.model).sessions.get(attempt.sessionId))
          );
        });

        const admission = yield* registerWorkerAdmission(
          store,
          attempt.sessionId,
          scope,
          resources.acquireWorker(attempt.sessionId),
          mayRelease
        );

        working.set(attempt.id, { scope, suspend: admission.suspend, observe: admission.observe });
        yield* Effect.gen(function* () {
          if (!(yield* mayRelease) && !(yield* admission.ensure)) return;
          const current = yield* currentAssignment;

          if (current === undefined || !retainsAssignment(assignmentAttempt(current))) {
            yield* stop(attempt.id).pipe(Effect.forkIn(parent), Effect.asVoid);

            return;
          }

          const continuing = resume || attempt.state === "blocked" || started.has(attempt.id);
          started.add(attempt.id);
          yield* (
            continuing
              ? hooks.resume(current, workerEnvironment(attempt))
              : hooks.start(current, workerEnvironment(attempt))
          ).pipe(Effect.provide(context));
          yield* admission.suspend;
        }).pipe(
          Effect.catchTag("StartupAbandoned", () =>
            Effect.sync(() => {
              abandoned = true;
            }).pipe(Effect.andThen(admission.suspend))
          ),
          Effect.catch((error) =>
            Effect.flatMap(currentAssignment, (current) =>
              current !== undefined &&
              current.graph.state !== "completed" &&
              current.graph.state !== "archived" &&
              retainsAssignment(assignmentAttempt(current))
                ? admission.retire
                : Effect.void
            ).pipe(
              Effect.andThen(hooks.failed(attempt, error).pipe(Effect.provide(context))),
              Effect.andThen(stop(attempt.id).pipe(Effect.forkIn(parent), Effect.asVoid))
            )
          ),
          Scope.provide(scope),
          Effect.forkIn(scope)
        );
      });

      const suspend = Effect.gen(function* () {
        for (const entry of working.values()) yield* entry.suspend;
      });

      let sequence = (yield* store.model).sequence;

      const observe = Effect.scoped(
        Effect.gen(function* () {
          const feed = yield* store.subscribe({
            filter: (item) =>
              Predicate.isTagged(item, "Event") &&
              (Predicate.isTagged(item.envelope.event, "TurnEnded") ||
                Predicate.isTagged(item.envelope.event, "SessionBackgroundTasksChanged") ||
                Predicate.isTagged(item.envelope.event, "SubagentStarted") ||
                Predicate.isTagged(item.envelope.event, "SubagentEnded") ||
                Predicate.isTagged(item.envelope.event, "SessionStateChanged")),
          });

          const cut = (yield* store.model).sequence;

          for (const assignment of yield* storage.assignments.pipe(Effect.orDie)) {
            const entry = working.get(assignment.attemptId);

            if (entry === undefined) continue;

            const suffix = yield* store
              .readEvents({
                after: sequence,
                upTo: cut,
                sessionId: assignmentAttempt(assignment).sessionId,
              })
              .pipe(Effect.orDie);

            for (const envelope of suffix) yield* entry.observe(envelope.event);
          }

          sequence = cut;
          yield* suspend;
          yield* feed.pipe(
            Stream.runForEach((item) =>
              Effect.gen(function* () {
                if (Predicate.isTagged(item, "Event") && item.envelope.sequence > sequence) {
                  for (const entry of working.values()) yield* entry.observe(item.envelope.event);
                  sequence = item.envelope.sequence;
                }
              })
            )
          );
        })
      );

      yield* observe.pipe(Effect.forever, Effect.forkIn(parent));
      yield* SubscriptionRef.changes(storage.changes).pipe(
        Stream.runForEach(() => suspend),
        Effect.forkIn(parent)
      );

      const restartStartup = Effect.fnUntraced(function* (attemptId: AttemptId) {
        const assignment = (yield* storage.assignments.pipe(Effect.orDie)).find(
          (a) => a.attemptId === attemptId
        );

        if (assignment === undefined) return false;
        const attempt = assignmentAttempt(assignment);

        if (
          attempt.hostId !== hostId ||
          attempt.state !== "working" ||
          assignment.graph.attempts.findLast((a) => a.taskId === attempt.taskId)?.id !==
            attempt.id ||
          assignment.graph.state === "completed" ||
          assignment.graph.state === "archived" ||
          (yield* storage.claimedAttempts.pipe(Effect.orDie)).has(attempt.id)
        )
          return false;

        for (const receipt of ["start", "startup-failed"])
          if (
            yield* store
              .hasCommandReceipt(CommandId.make(`${attemptId}:${receipt}`))
              .pipe(Effect.orDie)
          )
            return false;

        // The same path a Daemon restart takes: a fresh slot, then the brief exactly once.
        yield* stop(attemptId);
        yield* start(assignment, true).pipe(Effect.orDie);

        return true;
      });

      return {
        prepare: hooks.prepare,
        assigned: (assignment) => start(assignment, false),
        resume: (assignment) => start(assignment, true),
        claimed: stop,
        restartStartup,
      } satisfies RemoteWorkerHooks;
    })
  );
