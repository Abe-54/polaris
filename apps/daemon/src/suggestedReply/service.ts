/**
 * The fallback Suggested Reply (ENG-886, ADR 0106): after a Turn ends in a session whose
 * Harness has no suggestions of its own, one structured request to the Settings fallback.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DomainEvent,
  type SessionId,
  SuggestedReply,
  type SuggestedReplySettings,
  type TurnId,
} from "@polaris/protocol";
import {
  Cause,
  Context,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Match,
  Option,
  Predicate,
  Stream,
} from "effect";
import { Availability } from "../harness/availability/Availability.ts";
import { HarnessError } from "../harness/HarnessDriver.ts";
import { EventStore, type LiveItem } from "../store/EventStore.ts";
import { UsageIndex } from "../usage/service.ts";
import type { ReplyBackend } from "./backend.ts";
import { instructions, PROMPT_TURNS, replyJsonSchema, replyPrompt, replyText } from "./prompt.ts";
import { isInlineHarness, nearPlanLimit, resolveFallback, suggestionDue } from "./rules.ts";

/** A suggestion that takes longer is dropped; the user is likely typing by then. */
export const SUGGEST_TIMEOUT = Duration.seconds(15);

export interface SuggestedRepliesOptions {
  /** The Host preference, read at each ended Turn. */
  readonly settings: Effect.Effect<SuggestedReplySettings>;
  /** Default: the inline runners, or the scripted one under `POLARIS_BENCH_HARNESS=1`. */
  readonly backend?: ReplyBackend;
  readonly timeout?: Duration.Input;
}

/** Loaded on the first suggestion, so a Host with the preference off never loads the runners. */
const defaultBackend = () =>
  Effect.promise(async () =>
    process.env.POLARIS_BENCH_HARNESS === "1"
      ? (await import("./bench.ts")).benchReply
      : (await import("./live.ts")).liveReply
  );

/** A fresh directory only this user can write, removed when the request's scope closes. */
const scratch = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "polaris-suggest-")),
    catch: (cause) =>
      new HarnessError({
        harness: "polaris",
        message: "Could not make a scratch directory",
        cause,
      }),
  }),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
);

/** The session and Turn a Turn event names, and whether the Turn ended. */
const turnEvent = (event: DomainEvent) =>
  Match.value(event).pipe(
    Match.tags({
      TurnStarted: (e) => ({ sessionId: e.turn.sessionId, turnId: e.turn.id, ended: false }),
      TurnEnded: (e) => ({ sessionId: e.turn.sessionId, turnId: e.turn.id, ended: true }),
    }),
    Match.orElse(() => null)
  );

const make = (options: SuggestedRepliesOptions) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const availability = yield* Availability;
    const usage = yield* Effect.serviceOption(UsageIndex);
    const running = yield* FiberMap.make<SessionId>();
    const timeout = options.timeout ?? SUGGEST_TIMEOUT;
    let backend: ReplyBackend | undefined = options.backend;

    /** Still the latest ended Turn and still due one: checked under the commit lock. */
    const commit = (sessionId: SessionId, turnId: TurnId, text: string) =>
      store.commit({
        commandId: null,
        decide: (model) =>
          Effect.succeed(
            suggestionDue(model.sessions.get(sessionId))?.id === turnId
              ? [
                  DomainEvent.cases.SessionReplySuggested.make({
                    sessionId,
                    reply: SuggestedReply.make({ turnId, text, source: "polaris" }),
                  }),
                ]
              : []
          ),
      });

    const suggest = Effect.fn("suggestedReply.suggest")(function* (
      sessionId: SessionId,
      turnId: TurnId
    ) {
      const model = yield* store.model;
      const record = model.sessions.get(sessionId);

      if (record === undefined || suggestionDue(record)?.id !== turnId) return;

      const { choice } = resolveFallback(yield* options.settings, yield* availability.get(false));

      if (choice === null || !isInlineHarness(choice.harness)) return;
      const limits = Option.isSome(usage) ? yield* usage.value.planLimits : [];

      if (nearPlanLimit(record.session.harness, limits) || nearPlanLimit(choice.harness, limits))
        return;

      const turns = record.turns.filter((turn) => turn.status !== "working").slice(-PROMPT_TURNS);

      const items = yield* store.readTurnItems({
        turnIds: turns.map((turn) => turn.id),
        upTo: model.sequence,
      });

      backend ??= yield* defaultBackend();
      const run = backend;
      const harness = choice.harness;

      const job = {
        instructions,
        prompt: replyPrompt(turns, items),
        schema: replyJsonSchema,
        model: choice.model,
        effort: choice.effort,
        read: false,
      };

      // A private empty directory (0700): nothing in the cwd for either Harness to load.
      const answer = yield* Effect.scoped(
        Effect.flatMap(scratch, (dir) => run(harness, job, dir))
      ).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(new HarnessError({ harness: choice.harness, message: "timed out" })),
        })
      );

      const text = replyText(answer);

      if (text === null) return;
      yield* commit(sessionId, turnId, text);
    });

    /** Every failure is the user's to never see: logged, and the composer stays empty. */
    const quietly = (effect: Effect.Effect<void, unknown>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("suggested reply failed", cause)
        )
      );

    /** A new Turn cancels the one in flight; an ended one may start the next. */
    const onTurn = (sessionId: SessionId, turnId: TurnId, ended: boolean) =>
      Effect.gen(function* () {
        yield* FiberMap.remove(running, sessionId);

        if (!ended || !(yield* options.settings).enabled) return;

        // An event read late may name an older Turn than the session's latest.
        if (suggestionDue((yield* store.model).sessions.get(sessionId))?.id !== turnId) return;
        yield* FiberMap.run(running, sessionId, quietly(suggest(sessionId, turnId)));
      });

    const subscribe = store.subscribe({
      filter: (item) =>
        Predicate.isTagged(item, "Event") && turnEvent(item.envelope.event) !== null,
    });

    const follow = (live: Stream.Stream<LiveItem>) =>
      Stream.runForEach(live, (item) => {
        const found = Predicate.isTagged(item, "Event") ? turnEvent(item.envelope.event) : null;

        return found === null ? Effect.void : onTurn(found.sessionId, found.turnId, found.ended);
      });

    // Subscribed before the Layer is built; a subscriber that fell behind subscribes again.
    const first = yield* subscribe;
    const again = Effect.scoped(Effect.flatMap(subscribe, follow)).pipe(Effect.forever);
    yield* Effect.forkScoped(follow(first).pipe(Effect.andThen(again)));

    return SuggestedReplies.of({ inFlight: FiberMap.size(running) });
  });

export class SuggestedReplies extends Context.Service<
  SuggestedReplies,
  {
    /** Suggestions being written now (for tests and diagnostics). */
    readonly inFlight: Effect.Effect<number>;
  }
>()("polaris/daemon/suggestedReply/SuggestedReplies") {
  /** Follows the log from when it's built until its scope closes. */
  static readonly layer = (options: SuggestedRepliesOptions) =>
    Layer.effect(SuggestedReplies, make(options));
}
