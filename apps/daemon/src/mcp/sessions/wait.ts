/**
 * `wait_for_command`: holds the tool call until a session's background commands are done,
 * woken by the session's own commits. No timer runs outside a call.
 */
import type { BackgroundTask, SessionId, TurnItem } from "@polaris/protocol";
import { Data, Effect, Option, Predicate, Stream } from "effect";
import type { EventStore } from "../../store/EventStore.ts";
import type { ReadModel } from "../../store/model.ts";
import type { WaitOptions } from "./index.ts";

type CommandExecution = Extract<TurnItem, { _tag: "CommandExecution" }>;

export interface Finished {
  readonly task: BackgroundTask;
  /** Its command item, when the Harness recorded one under the task's id. */
  readonly command: CommandExecution | null;
}

export type WaitOutcome = Data.TaggedEnum<{
  Unavailable: Record<never, never>;
  NotFound: Record<never, never>;
  /** Nothing to wait for: no background command, or not the one named. */
  Idle: { readonly task: string | null };
  Finished: { readonly finished: ReadonlyArray<Finished> };
  /** The time ran out first. */
  Running: { readonly running: ReadonlyArray<BackgroundTask> };
}>;

export const WaitOutcome = Data.taggedEnum<WaitOutcome>();

/** How many recent Turns to search for a finished command's item. */
const RECENT_TURNS = 5;

const commandsOf = (model: ReadModel, sessionId: SessionId) =>
  (model.sessions.get(sessionId)?.session.backgroundTasks ?? []).filter(
    (task) => task.kind === "command"
  );

const commandItems = Effect.fnUntraced(function* (
  store: EventStore["Service"],
  sessionId: SessionId,
  ids: ReadonlySet<string>
) {
  const model = yield* store.model;
  const turns = yield* store.readTurns({ sessionId, beforeIndex: null, limit: RECENT_TURNS });

  const items = yield* store.readTurnItems({
    turnIds: turns.map((t) => t.id),
    upTo: model.sequence,
  });

  return new Map(
    [...items.values()]
      .flat()
      .filter(
        (item): item is CommandExecution =>
          Predicate.isTagged(item, "CommandExecution") && ids.has(item.id)
      )
      .map((item) => [item.id, item])
  );
});

export const waitForCommand = (
  store: EventStore["Service"],
  sessionId: SessionId,
  options: WaitOptions
): Effect.Effect<WaitOutcome> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Subscribe first, so a command that ends while the model is read still wakes the wait.
      const commits = yield* store.subscribe({
        sessionId,
        filter: (item) =>
          Predicate.isTagged(item, "Event") &&
          Predicate.isTagged(item.envelope.event, "SessionBackgroundTasksChanged"),
      });

      const start = yield* store.model;

      if (!start.sessions.has(sessionId)) return WaitOutcome.NotFound();

      const watched = commandsOf(start, sessionId).filter(
        (task) => options.task === null || task.id === options.task
      );

      if (watched.length === 0) return WaitOutcome.Idle({ task: options.task });

      const remaining = (model: ReadModel) => {
        const live = new Set(commandsOf(model, sessionId).map((task) => task.id));

        return watched.filter((task) => live.has(task.id));
      };

      yield* commits.pipe(
        Stream.mapEffect(() => Effect.map(store.model, (model) => remaining(model).length === 0)),
        Stream.takeUntil((done) => done),
        Stream.runDrain,
        Effect.timeoutOption(options.timeoutMs)
      );

      const running = remaining(yield* store.model);

      if (running.length > 0) return WaitOutcome.Running({ running });

      const items = yield* commandItems(store, sessionId, new Set(watched.map((t) => t.id))).pipe(
        Effect.option,
        Effect.map(Option.getOrElse(() => new Map<string, CommandExecution>()))
      );

      return WaitOutcome.Finished({
        finished: watched.map((task) => ({ task, command: items.get(task.id) ?? null })),
      });
    })
  );
