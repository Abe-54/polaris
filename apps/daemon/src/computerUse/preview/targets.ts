/**
 * What each Agent Session last did with computer use, as the preview needs it: the window it
 * acted on and, where the Host has no live capture, the screenshot its action took. The
 * `polaris_desktop` tools report here; nothing is kept on disk.
 */
import { AppRef, AppWindow, type SessionId } from "@polaris/protocol";
import { Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect";

/** The window a session last acted on. */
export interface PreviewTarget {
  readonly app: AppRef;
  readonly window: AppWindow;
}

/** The screenshot a session's last action took, as the Host's tool made it (a PNG). */
export interface PreviewScreenshot {
  readonly app: AppRef;
  /** Null for a capture of the whole screen. */
  readonly window: AppWindow | null;
  readonly image: Uint8Array;
  /** Milliseconds since the epoch. */
  readonly takenAt: number;
}

export interface PreviewAction {
  readonly app: AppRef;
  /** Null when the call names no window: the session's last window stays its target. */
  readonly window: AppWindow | null;
  /** Null when the action took none, or the Host can't take one (Wayland outside GNOME). */
  readonly screenshot: { readonly image: Uint8Array; readonly takenAt: number } | null;
}

/** Screenshots are whole PNGs in memory, so only the sessions that acted last keep theirs. */
export const MAX_KEPT_SCREENSHOTS = 8;

export class PreviewTargets extends Context.Service<
  PreviewTargets,
  {
    /** Records a computer use action of `sessionId`; watchers of its target hear of it. */
    readonly acted: (sessionId: SessionId, action: PreviewAction) => Effect.Effect<void>;
    /** Drops everything kept for a session that was archived or removed. */
    readonly forget: (sessionId: SessionId) => Effect.Effect<void>;
    readonly target: (sessionId: SessionId) => Effect.Effect<Option.Option<PreviewTarget>>;
    readonly screenshot: (sessionId: SessionId) => Effect.Effect<Option.Option<PreviewScreenshot>>;
    /**
     * The session's target now, then again after each of its actions (the same window too,
     * which restarts a capture that stopped) and when it is forgotten.
     */
    readonly watch: (sessionId: SessionId) => Stream.Stream<Option.Option<PreviewTarget>>;
  }
>()("polaris/daemon/computerUse/PreviewTargets") {
  /** `seed` is every session's target until it acts: the bench's stand-in for the tools. */
  static readonly layerWith = (seed: Option.Option<PreviewTarget>) =>
    Layer.effect(
      PreviewTargets,
      Effect.gen(function* () {
        const targets = new Map<SessionId, PreviewTarget>();
        const screenshots = new Map<SessionId, PreviewScreenshot>();
        const acted = yield* PubSub.unbounded<SessionId>();

        const target = (sessionId: SessionId) =>
          Effect.sync(() =>
            Option.orElse(Option.fromNullishOr(targets.get(sessionId)), () => seed)
          );

        const keep = (sessionId: SessionId, screenshot: PreviewScreenshot) => {
          // Re-inserted, so the map's order is oldest action first.
          screenshots.delete(sessionId);
          screenshots.set(sessionId, screenshot);

          for (const oldest of screenshots.keys()) {
            if (screenshots.size <= MAX_KEPT_SCREENSHOTS) break;
            screenshots.delete(oldest);
          }
        };

        return PreviewTargets.of({
          acted: (sessionId, action) =>
            Effect.suspend(() => {
              const { app, window, screenshot } = action;

              if (window !== null) targets.set(sessionId, { app, window });

              if (screenshot !== null) keep(sessionId, { app, window, ...screenshot });

              return PubSub.publish(acted, sessionId);
            }),
          forget: (sessionId) =>
            Effect.suspend(() => {
              targets.delete(sessionId);
              screenshots.delete(sessionId);

              return PubSub.publish(acted, sessionId);
            }),
          target,
          screenshot: (sessionId) =>
            Effect.sync(() => Option.fromNullishOr(screenshots.get(sessionId))),
          watch: (sessionId) =>
            Stream.unwrap(
              // Subscribed before the first read, so no action between the two is missed.
              Effect.map(PubSub.subscribe(acted), (subscription) =>
                Stream.concat(
                  Stream.fromEffect(target(sessionId)),
                  Stream.fromSubscription(subscription).pipe(
                    Stream.filter((id) => id === sessionId),
                    Stream.mapEffect(() => target(sessionId))
                  )
                )
              )
            ),
        });
      })
    );

  static readonly layer = PreviewTargets.layerWith(Option.none());

  /**
   * The Daemon's: with the bench Harness, `POLARIS_BENCH_PREVIEW_TARGET` (a JSON `PreviewTarget`)
   * is every session's target, since a scripted Harness calls no tool.
   */
  static readonly layerDaemon = Layer.suspend(() =>
    PreviewTargets.layerWith(
      process.env.POLARIS_BENCH_HARNESS === "1"
        ? decodeTarget(process.env.POLARIS_BENCH_PREVIEW_TARGET)
        : Option.none()
    )
  );
}

const decodeTarget = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ app: AppRef, window: AppWindow }))
);
