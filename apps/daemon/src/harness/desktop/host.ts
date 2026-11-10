/**
 * What `polaris_desktop` needs from the Host: whether computer use is ready (D1's status),
 * the environment agent-desktop needs to reach the display, and whether the screen is locked.
 */
import { Effect } from "effect";
import { AgentDesktop } from "../../install/agentDesktop/index.ts";
import { shortHostName } from "../../service/hostName.ts";
import { ComputerUseHelper } from "../../service/computerUse/index.ts";
import type { Env } from "./runner.ts";

export interface DesktopHost {
  /** Rechecks the Host: true when sessions get the tools (D1's `Ready`). */
  readonly ready: Effect.Effect<boolean>;
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
      ready: helper.permissions.pipe(
        Effect.map((permissions) => permissions.state === "ready"),
        Effect.orElseSucceed(() => false)
      ),
      env: Effect.succeed({}),
      locked: macLocked,
      name,
    } satisfies DesktopHost;
  }

  const agentDesktop = yield* AgentDesktop;

  return {
    ready: agentDesktop.current.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    ),
    env: Effect.succeed({}),
    locked: Effect.succeed(false),
    name,
  } satisfies DesktopHost;
});
