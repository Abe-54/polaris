import {
  type Attempt,
  type AttemptId,
  CommandId,
  type ConstellationId,
  type SessionId,
  ConstellationStreamItem,
  WorkerLiveness,
  type WorkerWaiting,
} from "@polaris/protocol";
import { type Cause, Effect, Queue, Stream } from "effect";
import {
  emptyLiveness,
  observeLiveness,
  projectLiveness,
  restoreLiveness,
  type LivenessFacts,
} from "../../harness/constellation/liveness.ts";
import { EventStore } from "../../store/EventStore.ts";
import type { ReadModel } from "../../store/model.ts";
import { latestAttempt } from "../projections.ts";
import { workerWait } from "../waiting.ts";
import type { ConstellationRecord } from "../../store/constellation.ts";
import type { ConstellationLivenessDelegate } from "../liveness.ts";

type Update = Extract<ConstellationStreamItem, { _tag: "LivenessChanged" }>;

export const livenessProvider = Effect.gen(function* () {
  const store = yield* EventStore;
  const facts = new Map<AttemptId, LivenessFacts>();
  const queued = new Map<AttemptId, number>();
  const subscribers = new Map<ConstellationId, Set<Queue.Queue<Update, Cause.Done>>>();

  const started = new Set<AttemptId>();

  /** The brief's Turn in the fold, else its receipt (the fold keeps recent Turns); once true, cached. */
  const firstTurn = Effect.fnUntraced(function* (model: ReadModel, attempt: Attempt) {
    if (started.has(attempt.id)) return true;
    const id = `${attempt.id}:start`;

    const seen =
      model.sessions.get(attempt.sessionId)?.turns.some((t) => t.id === id) === true ||
      (yield* store.hasCommandReceipt(CommandId.make(id)).pipe(Effect.orDie));

    if (seen) started.add(attempt.id);

    return seen;
  });

  const wire = (
    attemptId: AttemptId,
    activeTurn: boolean,
    first: boolean,
    waiting: WorkerWaiting | null
  ) => {
    const projected = projectLiveness(
      facts.get(attemptId) ?? emptyLiveness(),
      Date.now(),
      queued.get(attemptId) ?? 0,
      activeTurn
    );

    const current = projected.current;

    return WorkerLiveness.make({
      current:
        current === null
          ? null
          : {
              itemId: current.itemId,
              turnId: current.turnId,
              command: current.command,
              startedAt: current.startedAt,
            },
      lastOutputAt: projected.lastOutputAt,
      contextPercent: projected.contextPercent,
      queuedInput: projected.queuedInput,
      activeTurn,
      firstTurn: first,
      waiting,
    });
  };

  /** Waiting on Background Work, from the Session fold and the graph's declared waits. */
  const waitingOf = (model: ReadModel, record: ConstellationRecord, attempt: Attempt) => {
    const session = model.sessions.get(attempt.sessionId);

    return session === undefined ? null : workerWait(record, attempt, session);
  };

  /** True only when no Attempt has ever run in the Session (the store indexes them as they start). */
  const neverAssigned = (sessionId: SessionId) => store.hasStartupGraphs?.(sessionId) === false;

  /** From the Session fold, so "working" never implies a Turn the Session does not have. */
  const turnInFlight = (model: ReadModel, attempt: Attempt) =>
    model.sessions.get(attempt.sessionId)?.turns.some((t) => t.status === "working") === true;

  const publish = Effect.fnUntraced(function* (
    sessionId: SessionId,
    update: (attempt: Attempt) => void
  ) {
    const model = yield* store.model;

    const assignment = [...model.constellations.values()]
      .flatMap((record) =>
        record.graph.attempts
          .filter(
            (a) => a.sessionId === sessionId && latestAttempt(record.graph, a.taskId)?.id === a.id
          )
          .map((attempt) => ({ record, attempt }))
      )
      .sort((a, b) => a.attempt.startedAt.localeCompare(b.attempt.startedAt))
      .at(-1);

    if (assignment === undefined) return;
    const { record, attempt } = assignment;
    update(attempt);

    const item = ConstellationStreamItem.cases.LivenessChanged.make({
      attemptId: attempt.id,
      liveness: wire(
        attempt.id,
        turnInFlight(model, attempt),
        yield* firstTurn(model, attempt),
        waitingOf(model, record, attempt)
      ),
    });

    for (const queue of subscribers.get(record.graph.id) ?? []) Queue.offerUnsafe(queue, item);
  });

  const service = {
    read: Effect.fnUntraced(function* (record) {
      const result = new Map<AttemptId, WorkerLiveness>();
      const model = yield* store.model;
      const cut = model.sequence;

      for (const task of record.graph.tasks) {
        const attempt = latestAttempt(record.graph, task.id);

        if (attempt === undefined) continue;

        if (!facts.has(attempt.id)) {
          const history = yield* store
            .readEvents({ after: 0, upTo: cut, sessionId: attempt.sessionId })
            .pipe(Effect.orDie);

          facts.set(
            attempt.id,
            history
              .filter(
                (e) =>
                  e.occurredAt >= attempt.startedAt &&
                  (attempt.endedAt === null || e.occurredAt <= attempt.endedAt)
              )
              .reduce(
                (value, envelope) =>
                  restoreLiveness(value, envelope.event, Date.parse(envelope.occurredAt)),
                emptyLiveness()
              )
          );
        }

        result.set(
          attempt.id,
          wire(
            attempt.id,
            turnInFlight(model, attempt),
            yield* firstTurn(model, attempt),
            waitingOf(model, record, attempt)
          )
        );
      }

      return result;
    }),
    subscribe: Effect.fnUntraced(function* (id) {
      const queue = yield* Queue.sliding<Update, Cause.Done>(256);
      const bucket = subscribers.get(id) ?? new Set();
      bucket.add(queue);
      subscribers.set(id, bucket);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          bucket.delete(queue);

          if (bucket.size === 0) subscribers.delete(id);
          Queue.endUnsafe(queue);
        })
      );

      return Stream.fromQueue(queue);
    }),
    // Called for every Harness event (every Delta): a Session that never ran an Attempt returns at once.
    observe: (sessionId, event, at, queuedInput) =>
      Effect.suspend(() =>
        neverAssigned(sessionId)
          ? Effect.void
          : publish(sessionId, (attempt) => {
              facts.set(
                attempt.id,
                observeLiveness(facts.get(attempt.id) ?? emptyLiveness(), event, at)
              );

              if (queuedInput !== undefined) queued.set(attempt.id, queuedInput);
            })
      ),
    touch: (sessionId) =>
      Effect.suspend(() => (neverAssigned(sessionId) ? Effect.void : publish(sessionId, () => {}))),
    queued: (sessionId, count) =>
      Effect.suspend(() =>
        neverAssigned(sessionId)
          ? Effect.void
          : publish(sessionId, (attempt) => {
              queued.set(attempt.id, count);
            })
      ),
  } satisfies ConstellationLivenessDelegate;

  return service;
});
