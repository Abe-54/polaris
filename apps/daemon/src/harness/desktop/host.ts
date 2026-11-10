/**
 * What `polaris_desktop` needs from the Host: computer use's state (D1's status), the
 * environment agent-desktop needs to reach the display, and whether the screen is locked.
 */
import { ComputerUseState } from "@polaris/protocol";
import { Effect, Predicate, Stream } from "effect";
import { ComputerUseHost } from "../../computerUse/index.ts";
import { AgentDesktop } from "../../install/agentDesktop/index.ts";
import { shortHostName } from "../../service/hostName.ts";
import { ComputerUseHelper } from "../../service/computerUse/index.ts";
import type { Env } from "./runner.ts";

export interface DesktopHost {
  /** Rechecks the Host: `Ready` gets the tools, `Off` and `NeedsSetup` the request tool. */
  readonly state: Effect.Effect<ComputerUseState>;
  /** Completes once the Host is `Ready`. */
  readonly untilReady: Effect.Effect<void>;
  /** Merged into agent-desktop's environment (D1's `desktopEnv`: the display on Linux). */
  readonly env: Effect.Effect<Env>;
  readonly locked: Effect.Effect<boolean>;
  /** The Host's name in messages a person reads. */
  readonly name: string;
}

export const lockedMessage = (host: string) => `The screen on ${host} is locked.`;

/** `IOConsoleLocked` in the IORegistry root: true while the login window covers the session. */
export const consoleLocked = (ioreg: string): boolean =>
  /<key>IOConsoleLocked<\/key>\s*<true\/>/.test(ioreg);

const fromReady = (ready: Effect.Effect<boolean>) => ({
  state: Effect.map(ready, (yes) =>
    yes ? ComputerUseState.cases.Ready.make({}) : ComputerUseState.cases.NoDesktop.make({})
  ),
  untilReady: Effect.never,
});

const macLocked = Effect.tryPromise(async () => {
  const proc = Bun.spawn(["/usr/sbin/ioreg", "-n", "Root", "-d1", "-a"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  return consoleLocked(await new Response(proc.stdout).text());
}).pipe(Effect.orElseSucceed(() => false));

/**
 * Until D1's ComputerUseHost is wired in: on macOS, the helper holds its grants; elsewhere,
 * agent-desktop is installed. No display env, so a Linux service needs its own.
 */
export const localDesktopHost = Effect.gen(function* () {
  const name = shortHostName();

  if (process.platform === "darwin") {
    const helper = yield* ComputerUseHelper;

    return {
      ...fromReady(
        helper.permissions.pipe(
          Effect.map((permissions) => permissions.state === "ready"),
          Effect.orElseSucceed(() => false)
        )
      ),
      env: Effect.succeed({}),
      locked: macLocked,
      name,
    } satisfies DesktopHost;
  }

  const agentDesktop = yield* AgentDesktop;

  return {
    ...fromReady(
      agentDesktop.current.pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      )
    ),
    env: Effect.succeed({}),
    locked: Effect.succeed(false),
    name,
  } satisfies DesktopHost;
});

/** D1's `ComputerUseHost`: its state, rechecked on each session's open, and its display env. */
export const computerUseDesktopHost = Effect.gen(function* () {
  const host = yield* ComputerUseHost;

  return {
    state: Effect.map(host.ensure, (status) => status.state),
    untilReady: host.changes.pipe(
      Stream.filter((status) => Predicate.isTagged(status.state, "Ready")),
      Stream.runHead,
      Effect.asVoid
    ),
    env: host.desktopEnv,
    locked: process.platform === "darwin" ? macLocked : Effect.succeed(false),
    name: shortHostName(),
  } satisfies DesktopHost;
});
