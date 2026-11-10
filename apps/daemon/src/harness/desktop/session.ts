/**
 * One Agent Session's `polaris_desktop`: its agent-desktop session (snapshot namespace and
 * cursor overlay), what its calls have seen, and its display-awake hold.
 */
import { type AppRef, type AppWindow, ComputerUseCall, type SessionId } from "@polaris/protocol";
import { Effect, Option, Predicate, Schema } from "effect";
import {
  type Authorize,
  mixedApps,
  NAME_THE_APP,
  SCREEN_NEEDS_APP,
  unknownApp,
  UNSEEN_TARGET,
} from "./authorize.ts";
import { type DisplayAwake, turnAwake } from "./awake.ts";
import { argvFor, type DesktopTool, type Json, type ParsedCall } from "./catalog.ts";
import {
  type DesktopResult,
  envelopeOf,
  failure,
  imageOf,
  resultOf,
  type ScreenshotData,
} from "./envelope.ts";
import { type DesktopHost, lockedMessage } from "./host.ts";
import { listedApps, pickApp, Sightings } from "./metadata.ts";
import type { DesktopRunner } from "./runner.ts";
import { decodeDisplays, screenNote, shrink, WINDOW_NOTE } from "./screenshot.ts";
import { type Takeover, tookOver } from "./takeover.ts";

/** The cursor overlay's label: the session's title, cut to six words. */
export const overlayLabel = (title: string | null): string => {
  const words = (title ?? "").trim().split(/\s+/).filter(Boolean);

  return words.length === 0 ? "Polaris" : words.slice(0, 6).join(" ");
};

export interface DesktopSessionDeps {
  readonly sessionId: SessionId;
  readonly runner: DesktopRunner;
  readonly host: DesktopHost;
  readonly authorize: Authorize;
  /** The Host's, shared by its sessions. */
  readonly takeover: Takeover;
  readonly awake: DisplayAwake;
  readonly title: Effect.Effect<string | null>;
  readonly acted?: Acted | undefined;
}

/** What an action showed: D4's preview follows the app and window, and keeps the screenshot. */
export interface ActedOn {
  readonly app: AppRef;
  readonly window: AppWindow | null;
  readonly screenshot: { readonly image: Uint8Array; readonly takenAt: number } | null;
}

/** D4's `PreviewTargets.acted`, called after each call that acted on an app. */
export type Acted = (sessionId: SessionId, on: ActedOn) => Effect.Effect<void>;

const Started = Schema.Struct({ session_id: Schema.String });

const decodeStarted = Schema.decodeUnknownOption(Started);

const encodeCall = Schema.encodeSync(ComputerUseCall);

export const desktopSession = (deps: DesktopSessionDeps) => {
  const sightings = new Sightings();
  const awake = turnAwake(deps.awake);
  let session: string | null = null;
  let starting: Promise<string | null> | null = null;

  const run = (args: ReadonlyArray<string>, signal?: AbortSignal) =>
    Effect.flatMap(deps.host.env, (env) => deps.runner.run(args, env, signal));

  const envelope = (args: ReadonlyArray<string>) =>
    run(args).pipe(Effect.map((stdout) => Option.getOrNull(envelopeOf(stdout))));

  /** `session start`, then the overlay; without them calls still work, in the global namespace. */
  const start = Effect.gen(function* () {
    const name = `polaris-${deps.sessionId}`;
    const started = yield* envelope(["session", "start", "--no-trace", "--name", name]);
    const id = started?.ok ? Option.getOrNull(decodeStarted(started.data))?.session_id : undefined;

    if (id === undefined) return null;
    const label = overlayLabel(yield* deps.title);
    const overlay = ["cursor-overlay", "enable", "--label", label, "--max-words", "6"];
    yield* Effect.ignore(envelope(["--session", id, ...overlay]));

    return id;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning(`session ${deps.sessionId}: no agent-desktop session`, cause),
        null
      )
    )
  );

  const ensureSession = Effect.suspend(() => {
    if (session !== null) return Effect.succeed(session);
    starting ??= Effect.runPromise(start).then((id) => (session = id));

    return Effect.promise(() => starting ?? Promise.resolve(null));
  });

  /**
   * The app a call is for, by its stable id: among the running apps agent-desktop matches for
   * the name, else an installed one the Host knows. Null when the call names none.
   */
  /** One name to its app: among the running apps agent-desktop matches for it, else an installed one. */
  const identifyOne = Effect.fnUntraced(function* (asked: string) {
    const known = sightings.appOf(asked);

    if (known !== undefined) return known;
    const listing = envelope(["list-apps", `--app=${asked}`]);
    const running = pickApp(asked, listedApps(yield* Effect.orElseSucceed(listing, () => null)));

    if (running === "ambiguous") return null;
    const app = running ?? (yield* deps.host.identify(asked));

    if (app !== null) sightings.resolved(asked, app);

    return app;
  });

  /**
   * The one app a call is for. Its `app`, its ref and its window must all be the same app, and
   * a ref or window this session never saw is refused: the policy decides for what really acts.
   */
  const identify = Effect.fnUntraced(function* (target: ParsedCall["target"]) {
    const { names, unknown } = sightings.askedApps(target);

    if (unknown) return { app: null, refusal: UNSEEN_TARGET };
    const apps: Array<AppRef> = [];

    for (const asked of names) {
      const app = yield* identifyOne(asked);

      if (app === null) return { app: null, refusal: unknownApp(asked, deps.host.name) };
      apps.push(app);
    }

    const [first = null, ...rest] = apps;
    const other = rest.find((app) => app.id !== first?.id);

    return other === undefined || first === null
      ? { app: first, refusal: null }
      : { app: null, refusal: mixedApps(first.name, other.name) };
  });

  /** Whether the user is at the pointer or keyboard now, so headed input would fight them. */
  const userActive = Effect.map(deps.host.inputIdle, (idle) => deps.takeover.userActive(idle));

  const screenshotParts = Effect.fnUntraced(function* (
    shot: ScreenshotData,
    screen: number | null
  ) {
    const shrunk = yield* shrink(shot);

    if (screen === null) return { image: shrunk.image, note: WINDOW_NOTE };
    const listed = yield* Effect.orElseSucceed(envelope(["list-displays"]), () => null);
    const displays = Option.getOrElse(decodeDisplays(listed?.data), () => []);

    return { image: shrunk.image, note: screenNote(displays, screen, shrunk.pixelsPerPoint) };
  });

  const act = Effect.fnUntraced(function* (
    definition: DesktopTool,
    parsed: ParsedCall,
    signal?: AbortSignal
  ) {
    yield* awake.use;
    const id = yield* ensureSession;

    const stdout = yield* run(argvFor(definition, parsed, id), signal).pipe(
      Effect.ensuring(Effect.sync(() => definition.observes || deps.takeover.acted()))
    );

    const result = Option.getOrNull(envelopeOf(stdout));

    if (result === null)
      return failure(`agent-desktop answered with no result: ${stdout.slice(0, 500)}`);
    sightings.see(result);
    const shot = imageOf(result);
    const extra = shot === null ? null : yield* screenshotParts(shot, parsed.screen);
    const acted = sightings.callOf(parsed.target, definition.headed, result);

    if (acted.app !== null && deps.acted !== undefined) {
      const screenshot =
        shot === null ? null : { image: Buffer.from(shot.data, "base64"), takenAt: Date.now() };

      yield* deps.acted(deps.sessionId, { app: acted.app, window: acted.window, screenshot });
    }

    return resultOf({
      envelope: result,
      computerUse: encodeCall(acted),
      image: extra?.image ?? null,
      note: extra?.note ?? null,
    });
  });

  const call = Effect.fnUntraced(function* (
    definition: DesktopTool,
    input: Json,
    signal?: AbortSignal
  ) {
    const parsed = Option.getOrNull(definition.parse(input));

    if (parsed === null) return failure(`Invalid input for ${definition.name}.`);

    if (yield* deps.host.locked) return failure(lockedMessage(deps.host.name));
    const { app, refusal } = yield* identify(parsed.target);

    if (refusal !== null) return failure(refusal);

    if (app === null) {
      if (!definition.hostWide) return failure(NAME_THE_APP);

      // The whole screen shows every app: only while the user has let this session into one.
      if (parsed.screen !== null && !(yield* deps.authorize.controlling(deps.sessionId)))
        return failure(SCREEN_NEEDS_APP);

      return yield* act(definition, parsed, signal);
    }

    const authorization = yield* deps.authorize.use({
      sessionId: deps.sessionId,
      app,
      headed: definition.headed,
      signal,
    });

    if (Predicate.isTagged(authorization, "Refuse")) return failure(authorization.message);

    // The user who just answered the approval is at the Host: that input isn't a takeover.
    if (definition.headed && !authorization.asked && (yield* userActive))
      return failure(tookOver(deps.host.name));

    return yield* act(definition, parsed, signal);
  });

  return {
    call: (definition: DesktopTool, input: Json, signal?: AbortSignal) =>
      call(definition, input, signal).pipe(
        Effect.catchTag("DesktopRunFailed", (error) => Effect.succeed(failure(error.message)))
      ) satisfies Effect.Effect<DesktopResult>,
    /** The Turn ended: let the display sleep again, and release the session's Controlled apps. */
    turnEnded: Effect.andThen(awake.release, deps.authorize.release(deps.sessionId)),
    /** Ends the agent-desktop session, which takes its overlay down, and sweeps ended ones. */
    close: Effect.suspend(() => {
      const stopped = Effect.andThen(awake.release, deps.authorize.forget(deps.sessionId));

      if (session === null) return stopped;
      const end = envelope(["session", "end", session]);
      const sweep = envelope(["session", "gc", "--ended"]);

      return Effect.andThen(stopped, Effect.ignore(Effect.andThen(end, sweep)));
    }),
  };
};

export type DesktopSession = ReturnType<typeof desktopSession>;
