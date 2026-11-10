/**
 * What `polaris_desktop` needs from the Host: computer use's state (D1's status),
 * the environment agent-desktop needs to reach the display, and whether the screen is locked.
 */
import { dlopen, FFIType } from "bun:ffi";
import { AppId, AppRef, type ComputerUseState } from "@polaris/protocol";
import { Effect, Predicate, Stream } from "effect";
import { ComputerUseHost } from "../../computerUse/host.ts";
import { childEnv } from "../../service/childEnv.ts";
import { shortHostName } from "../../service/hostName.ts";
import type { Env } from "./runner.ts";

export interface DesktopHost {
  /** Rechecks the Host: `Ready` gets the tools, `Off` and `NeedsSetup` the request tool. */
  readonly state: Effect.Effect<ComputerUseState>;
  /** Completes once the Host is `Ready`. */
  readonly untilReady: Effect.Effect<void>;
  /** Merged into agent-desktop's environment (D1's `desktopEnv`: the display on Linux). */
  readonly env: Effect.Effect<Env>;
  readonly locked: Effect.Effect<boolean>;
  /** Milliseconds since the Host's last pointer or keyboard input; null where it can't tell. */
  readonly inputIdle: Effect.Effect<number | null>;
  /** An app that isn't running, by the name or id the agent gave; null when the Host has none. */
  readonly identify: (app: string) => Effect.Effect<AppRef | null>;
  /** The Host's name in messages a person reads. */
  readonly name: string;
}

export const lockedMessage = (host: string) => `The screen on ${host} is locked.`;

/** `IOConsoleLocked` in the IORegistry root: true while the login window covers the session. */
export const consoleLocked = (ioreg: string): boolean =>
  /<key>IOConsoleLocked<\/key>\s*<true\/>/.test(ioreg);

const macLocked = Effect.tryPromise(async () => {
  const proc = Bun.spawn(["/usr/sbin/ioreg", "-n", "Root", "-d1", "-a"], {
    env: childEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  return consoleLocked(await new Response(proc.stdout).text());
}).pipe(Effect.orElseSucceed(() => false));

/** Seconds since the Host's last pointer or keyboard event, hardware or synthetic (CoreGraphics). */
const macIdleSeconds = (() => {
  let read: (() => number) | null | undefined;

  return () => {
    if (read === undefined) {
      try {
        const { symbols } = dlopen(
          "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
          {
            CGEventSourceSecondsSinceLastEventType: {
              args: [FFIType.i32, FFIType.u32],
              returns: FFIType.f64,
            },
          }
        );

        // kCGEventSourceStateHIDSystemState, kCGAnyInputEventType.
        read = () => symbols.CGEventSourceSecondsSinceLastEventType(1, 0xffffffff);
      } catch {
        read = null;
      }
    }

    return read === null ? null : read();
  };
})();

const macInputIdle = Effect.sync(() => {
  const seconds = macIdleSeconds();

  return seconds === null || !Number.isFinite(seconds) ? null : seconds * 1000;
});

/** The id of an installed app that isn't running, by name or bundle id; the name is an argument, never script. */
const BUNDLE_ID_SCRIPT = [
  "on run argv",
  "set asked to item 1 of argv",
  "try",
  "return id of application asked",
  "on error",
  "return id of application id asked",
  "end try",
  "end run",
];

const macIdentify = (app: string) =>
  Effect.tryPromise(async () => {
    const script = BUNDLE_ID_SCRIPT.flatMap((line) => ["-e", line]);

    const proc = Bun.spawn(["/usr/bin/osascript", ...script, "--", app], {
      env: childEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });

    const id = (await new Response(proc.stdout).text()).trim();

    return (await proc.exited) === 0 && id !== ""
      ? new AppRef({ id: AppId.make(id), name: app })
      : null;
  }).pipe(
    Effect.timeoutOrElse({ duration: 5000, orElse: () => Effect.succeed(null) }),
    Effect.orElseSucceed(() => null)
  );

/** The Host as D1's `ComputerUseHost` reports it: the tools follow its status and its display. */
export const computerUseDesktopHost = Effect.gen(function* () {
  const host = yield* ComputerUseHost;
  const mac = process.platform === "darwin";

  return {
    state: Effect.map(host.ensure, (status) => status.state),
    untilReady: host.changes.pipe(
      Stream.filter((status) => Predicate.isTagged(status.state, "Ready")),
      Stream.runHead,
      Effect.asVoid
    ),
    env: host.desktopEnv,
    locked: mac ? macLocked : Effect.succeed(false),
    inputIdle: mac ? macInputIdle : Effect.succeed(null),
    // Off macOS an app has no id but the name agent-desktop takes.
    identify: mac
      ? macIdentify
      : (app) => Effect.succeed(new AppRef({ id: AppId.make(app), name: app })),
    name: shortHostName(),
  } satisfies DesktopHost;
});
