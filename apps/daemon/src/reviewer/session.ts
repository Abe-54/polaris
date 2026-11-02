/**
 * The Reviewer's own Agent Session ("Reviewer · <PR>" in the Orchestrator):
 * started in the Review Checkout through the Engine like any session, its
 * approvals answered by the read-only policy, its Turns awaited here.
 */
import {
  CommandId,
  DomainEvent,
  type ReviewCheckoutId,
  type ReviewerChoice,
  SessionId,
  type SessionOrigin,
  type Turn,
  type TurnId,
  type WorkspaceId,
  Command,
  SessionPlacement,
} from "@polaris/protocol";
import { Duration, Effect, Option, Predicate, Result, Stream } from "effect";
import { Engine } from "../engine/Engine.ts";
import { finalReply } from "../engine/fork.ts";
import { ServiceError } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { sandboxLaunchFailure } from "./launch.ts";
import { ReviewerSessions } from "./sessions.ts";
import type { LiveItem } from "../store/hub.ts";

/** Who the Engine records as sending the Reviewer's commands. */
export const REVIEWER_DEVICE = "Reviewer";

/** A Turn the Reviewer hasn't finished in this long is interrupted and the layer fails. */
export const TURN_TIMEOUT = Duration.minutes(30);

export interface TurnOutcome {
  readonly turnId: TurnId;
  readonly status: Turn["status"];
  /** The Turn's last assistant message; null when it wrote none. */
  readonly reply: string | null;
  /** Why it didn't complete, as the session recorded it; null when it completed. */
  readonly error: string | null;
  /** A command's line saying the Harness's sandbox didn't start; null when none said so. */
  readonly sandboxFailure: string | null;
}

/** The reason of the session's last state change after `after`: why a Turn failed. */
const failureReason = (sessionId: SessionId, after: number) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const model = yield* store.model;

    const events = yield* store
      .readEvents({ after, upTo: model.sequence, sessionId })
      .pipe(Effect.orElseSucceed(() => []));

    return (
      events
        .map((envelope) => envelope.event)
        .filter(DomainEvent.guards.SessionStateChanged)
        .findLast((event) => event.reason !== null)?.reason ?? null
    );
  });

const newCommandId = () => CommandId.make(`cmd_${crypto.randomUUID()}`);

const turnEndedIn =
  (sessionId: SessionId, fromIndex: number) =>
  (item: LiveItem): Turn | null => {
    if (!Predicate.isTagged(item, "Event")) return null;
    const event = item.envelope.event;

    return DomainEvent.guards.TurnEnded(event) &&
      event.turn.sessionId === sessionId &&
      event.turn.index >= fromIndex
      ? event.turn
      : null;
  };

/**
 * Sends a command that starts a Turn (`send`) and waits for that Turn to end:
 * subscribes first, so the end can't slip past between the two.
 */
const runTurn = <E>(
  sessionId: SessionId,
  fromIndex: number,
  send: Effect.Effect<unknown, E, Engine>,
  onSent: (turnId: TurnId) => Effect.Effect<void> = () => Effect.void,
  onAssistant?: (text: string) => Effect.Effect<void>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* EventStore;
      const engine = yield* Engine;
      const ended = turnEndedIn(sessionId, fromIndex);
      const live = yield* store.subscribe({ sessionId });

      const sentAt = (yield* store.model).sequence;
      yield* send;

      const sent = (yield* store.model).sessions
        .get(sessionId)
        ?.turns.find((t) => t.index >= fromIndex);

      if (sent !== undefined) yield* onSent(sent.id);

      const partial = new Map<string, string>();

      const waited = yield* live.pipe(
        Stream.tap((item) => {
          if (onAssistant === undefined) return Effect.void;

          if (
            Predicate.isTagged(item, "Delta") &&
            item.field === "text" &&
            item.subagentId === null
          ) {
            const text = ((partial.get(item.itemId) ?? "") + item.text).slice(0, 240_000);
            partial.set(item.itemId, text);

            return text.startsWith("## Why the change") ? onAssistant(text) : Effect.void;
          }

          if (
            Predicate.isTagged(item, "ItemProgress") &&
            Predicate.isTagged(item.item, "AssistantMessage")
          )
            return onAssistant(item.item.text);

          return Effect.void;
        }),
        Stream.filterMap((item) => {
          const turn = ended(item);

          return turn === null ? Result.failVoid : Result.succeed(turn);
        }),
        Stream.runHead,
        Effect.timeoutOption(TURN_TIMEOUT)
      );

      const turn = Option.flatten(waited);

      if (Option.isNone(turn)) {
        yield* engine
          .dispatch({
            commandId: newCommandId(),
            command: Command.cases.Interrupt.make({ sessionId }),
            deviceLabel: REVIEWER_DEVICE,
          })
          .pipe(Effect.ignore);

        return yield* new ServiceError({
          service: "Reviewer",
          message: "The Reviewer took too long and was stopped.",
        });
      }

      const model = yield* store.model;

      const items = yield* store.readTurnItems({
        turnIds: [turn.value.id],
        upTo: model.sequence,
      });

      const turnItems = items.get(turn.value.id);

      return {
        turnId: turn.value.id,
        status: turn.value.status,
        reply: finalReply(turnItems),
        sandboxFailure: sandboxLaunchFailure(turnItems ?? []),
        error: turn.value.status === "completed" ? null : yield* failureReason(sessionId, sentAt),
      } satisfies TurnOutcome;
    })
  );

const dispatch = (command: Command) =>
  Effect.gen(function* () {
    const engine = yield* Engine;

    return yield* engine.dispatch({
      commandId: newCommandId(),
      command,
      deviceLabel: REVIEWER_DEVICE,
    });
  });

export interface StartReviewer {
  readonly workspaceId: WorkspaceId;
  /** The Review Checkout it works in; null works in the Workspace (an Agent Session's Review). */
  readonly checkoutId: ReviewCheckoutId | null;
  readonly choice: ReviewerChoice;
  readonly title: string;
  readonly prompt: string;
  /** What the session is for, so the sidebar files it under Reviews; a Reviewer's by default. */
  readonly origin?: SessionOrigin;
  readonly onStarted?: (sessionId: SessionId) => Effect.Effect<void>;
  readonly onAssistant?: (text: string) => Effect.Effect<void>;
}

/** Starts the Reviewer's session with its first Turn, and waits for that Turn. */
export const startReviewerSession = (options: StartReviewer) =>
  Effect.gen(function* () {
    const sessionId = SessionId.make(`ses_${crypto.randomUUID()}`);
    yield* (yield* ReviewerSessions).register(sessionId);

    const start = Effect.gen(function* () {
      yield* dispatch(
        Command.cases.StartSession.make({
          sessionId,
          workspaceId: options.workspaceId,
          harness: options.choice.harness,
          placement:
            options.checkoutId === null
              ? SessionPlacement.cases.InPlace.make({})
              : SessionPlacement.cases.ReviewCheckout.make({ checkoutId: options.checkoutId }),
          permissionMode: "supervised",
          model: options.choice.model,
          effort: options.choice.effort,
          prompt: options.prompt,
          attachments: [],
          origin: options.origin ?? "reviewer",
        })
      );
      yield* dispatch(Command.cases.RenameSession.make({ sessionId, title: options.title }));

      if (options.onStarted !== undefined) yield* options.onStarted(sessionId);
    });

    const outcome = yield* runTurn(sessionId, 0, start, undefined, options.onAssistant);

    return { sessionId, ...outcome };
  });

/**
 * Continues the Reviewer's session with another Turn (a follow-up, or a
 * repair) and waits for it; `onSent` learns the Turn's id once it is recorded.
 */
export const continueReviewerSession = (
  sessionId: SessionId,
  prompt: string,
  onSent?: (turnId: TurnId) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    yield* (yield* ReviewerSessions).register(sessionId);
    const record = (yield* store.model).sessions.get(sessionId);
    const fromIndex = record?.session.turnCount ?? 0;

    return yield* runTurn(
      sessionId,
      fromIndex,
      dispatch(Command.cases.SendTurn.make({ sessionId, prompt, attachments: [] })),
      onSent
    );
  });
