/**
 * The live preview on macOS: `polaris-capture` run inside Polaris Computer Use.app, so its
 * Screen Recording grant applies (ADR 0107). One process per watched session, size and link,
 * shared by its watchers, started with the first and killed with the last.
 */
import {
  PREVIEW_MAX_EDGE_PX,
  PREVIEW_MAX_FPS,
  PREVIEW_MAX_FRAME_BYTES,
  type SessionId,
} from "@polaris/protocol";
import { Data, Duration, Effect, Layer, Option, PubSub, RcMap, Stream } from "effect";
import { COMPUTER_USE_CAPTURE } from "../../service/computerUse/bundle.ts";
import { ComputerUseHelper, type HelperProcess } from "../../service/computerUse/index.ts";
import { CaptureRecord, recordParser } from "./records.ts";
import { PreviewEvent, type PreviewImage, PreviewSource, type WatchRequest } from "./source.ts";
import { type PreviewTarget, PreviewTargets } from "./targets.ts";

/** `polaris-capture`'s exit code when macOS has not granted the helper Screen Recording. */
export const EXIT_NOT_READY = 3;

export interface CaptureOptions {
  /** How long after a missing grant the capture is tried again, while someone watches. */
  readonly retryNotReady?: Duration.Input;
  /** How long after the tool ends for any other reason. */
  readonly retryStopped?: Duration.Input;
  /** How long `latest` waits for its one image. */
  readonly latestTimeout?: Duration.Input;
}

/** One capture process's identity: watchers that agree on all three share it. */
class Feed extends Data.Class<WatchRequest> {}

/**
 * A window's CGWindowID from its id as text: `4242`, or agent-desktop's `w-4242`. None for
 * any other text, which is no window the capture tool can find.
 */
export const windowNumber = (id: string): Option.Option<number> =>
  Option.filter(
    Option.map(Option.fromNullishOr(/^(?:w-)?(\d{1,10})$/.exec(id)), (match) => Number(match[1])),
    (number) => number <= 0xffff_ffff
  );

/** One line for the tool's stdin. */
const command = (target: Option.Option<PreviewTarget>, edge: number, fps: number) => {
  const window = Option.getOrNull(Option.flatMap(target, (found) => windowNumber(found.window.id)));

  return `${JSON.stringify({ window, edge, fps })}\n`;
};

const longerSide = (image: PreviewImage) => Math.max(image.width, image.height);

/** The record as an event, for the session's target now; none for a frame of an older one. */
const eventOf = (
  record: CaptureRecord,
  target: Option.Option<PreviewTarget>
): Option.Option<PreviewEvent> =>
  CaptureRecord.$match(record, {
    Idle: ({ reason }) => Option.some(PreviewEvent.Idle({ reason })),
    Frame: ({ _tag, window, ...facts }) =>
      Option.map(
        Option.filter(
          target,
          (found) =>
            Option.contains(windowNumber(found.window.id), window) &&
            facts.jpeg.length <= PREVIEW_MAX_FRAME_BYTES &&
            Math.max(facts.width, facts.height) <= PREVIEW_MAX_EDGE_PX
        ),
        (found) => PreviewEvent.Frame({ image: { ...facts, app: found.app, window: found.window } })
      ),
  });

const chunks = (stream: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({ evaluate: () => stream, onError: () => "closed" as const });

/** The tool's records as they complete; the stream ends when its output stops making sense. */
const records = (running: HelperProcess) => {
  const parser = recordParser();

  return chunks(running.stdout).pipe(
    Stream.map((chunk) => parser.push(chunk)),
    Stream.takeWhile(Option.isSome),
    Stream.flatMap((parsed) => Stream.fromIterable(parsed.value)),
    Stream.catch(() => Stream.empty)
  );
};

export const captureLayer = (options: CaptureOptions = {}) =>
  Layer.effect(
    PreviewSource,
    Effect.gen(function* () {
      const helper = yield* ComputerUseHelper;
      const targets = yield* PreviewTargets;
      /** Each watched session's newest frame, for `latest` to answer without a second capture. */
      const newest = new Map<SessionId, PreviewImage>();
      const retryNotReady = Duration.fromInputUnsafe(options.retryNotReady ?? "5 seconds");
      const retryStopped = Duration.fromInputUnsafe(options.retryStopped ?? "2 seconds");
      const latestTimeout = Duration.fromInputUnsafe(options.latestTimeout ?? "5 seconds");

      /** Starts the tool, tells it the session's target and each later one. Scoped: closing kills it. */
      const start = Effect.fnUntraced(function* (sessionId: SessionId, edge: number, fps: number) {
        const running = yield* helper.spawn({ tool: COMPUTER_USE_CAPTURE, args: [] });

        yield* targets.watch(sessionId).pipe(
          Stream.runForEach((target) =>
            Effect.sync(() => running.write(command(target, edge, fps)))
          ),
          Effect.forkScoped
        );
        yield* Stream.runDrain(chunks(running.stderr)).pipe(Effect.ignore, Effect.forkScoped);

        return running;
      });

      /** Runs the tool until it ends, publishing what it captures; answers its exit code. */
      const capture = (feed: Feed, events: PubSub.PubSub<PreviewEvent>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const running = yield* start(feed.sessionId, feed.edge, PREVIEW_MAX_FPS[feed.link]);

            yield* records(running).pipe(
              Stream.mapEffect((record) =>
                Effect.map(targets.target(feed.sessionId), (target) => eventOf(record, target))
              ),
              Stream.runForEach(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (event) => {
                    if (PreviewEvent.$is("Frame")(event)) newest.set(feed.sessionId, event.image);

                    return PubSub.publish(events, event);
                  },
                })
              ),
              // Output that makes no sense is not the capture tool's: stop it.
              Effect.ensuring(Effect.sync(() => running.kill("SIGKILL"))),
              Effect.forkScoped
            );

            return yield* Effect.promise(() => running.exited);
          })
        ).pipe(Effect.catchTag("ComputerUseUnavailable", () => Effect.succeed(EXIT_NOT_READY)));

      /** While watched: waits for the session to have a target, captures it, and tries again. */
      const run = (feed: Feed, events: PubSub.PubSub<PreviewEvent>) =>
        Effect.gen(function* () {
          const idle = (reason: "no-window" | "not-ready") =>
            PubSub.publish(events, PreviewEvent.Idle({ reason }));

          while (true) {
            if (Option.isNone(yield* targets.target(feed.sessionId))) yield* idle("no-window");

            yield* targets.watch(feed.sessionId).pipe(Stream.filter(Option.isSome), Stream.runHead);

            const notReady = (yield* capture(feed, events)) === EXIT_NOT_READY;
            newest.delete(feed.sessionId);
            yield* idle(notReady ? "not-ready" : "no-window");
            yield* Effect.sleep(notReady ? retryNotReady : retryStopped);
          }
        });

      const feeds = yield* RcMap.make({
        lookup: (feed: Feed) =>
          Effect.gen(function* () {
            // One slot that slides: a slow watcher gets the newest event, never a backlog.
            const events = yield* PubSub.sliding<PreviewEvent>({ capacity: 1, replay: 1 });
            yield* Effect.addFinalizer(() => Effect.sync(() => newest.delete(feed.sessionId)));
            yield* Effect.forkScoped(run(feed, events));

            return events;
          }),
      });

      /** One image from a tool started for it alone, then killed. */
      const once = (sessionId: SessionId, edge: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const target = yield* targets.target(sessionId);
            const running = yield* start(sessionId, edge, 1);
            const first = yield* Stream.runHead(records(running));

            return Option.flatMap(first, (record) =>
              Option.flatMap(eventOf(record, target), (event) =>
                PreviewEvent.$is("Frame")(event) ? Option.some(event.image) : Option.none()
              )
            );
          })
        ).pipe(
          Effect.timeoutOption(latestTimeout),
          Effect.map(Option.flatten),
          Effect.catchTag("ComputerUseUnavailable", () => Effect.succeedNone)
        );

      return PreviewSource.of({
        live: true,
        watch: (request) =>
          Stream.unwrap(Effect.map(RcMap.get(feeds, new Feed(request)), Stream.fromPubSub)),
        latest: ({ sessionId, edge }) =>
          Effect.gen(function* () {
            const watched = Option.filter(
              Option.fromNullishOr(newest.get(sessionId)),
              (image) => longerSide(image) <= edge
            );

            if (Option.isSome(watched)) return watched;

            if (Option.isNone(yield* targets.target(sessionId))) return Option.none();

            return yield* once(sessionId, edge);
          }),
      });
    })
  );
