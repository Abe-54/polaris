/**
 * Runs one agent-desktop command and answers its stdout. On macOS it runs inside Polaris
 * Computer Use.app (D5), so TCC charges the helper; elsewhere the Host's installed binary.
 */
import { Duration, Effect, Schema } from "effect";
import { AgentDesktop } from "../../install/agentDesktop/index.ts";
import { childEnv } from "../../service/childEnv.ts";
import { ComputerUseHelper } from "../../service/computerUse/index.ts";

export class DesktopRunFailed extends Schema.TaggedError<DesktopRunFailed>()("DesktopRunFailed", {
  message: Schema.String,
}) {}

export type Env = Readonly<Record<string, string>>;

export interface DesktopRunner {
  readonly run: (
    args: ReadonlyArray<string>,
    env: Env,
    signal?: AbortSignal
  ) => Effect.Effect<string, DesktopRunFailed>;
}

/** Longer than agent-desktop's own waits (30 s launch, 30 s `--wait-for`). */
export const RUN_TIMEOUT = Duration.seconds(90);

interface Running {
  readonly stdout: ReadableStream<Uint8Array>;
  /** Drained and dropped, so a chatty tool never blocks on a full pipe. */
  readonly stderr?: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kill: (signal?: "SIGTERM" | "SIGKILL") => void;
}

const failed = (what: string) => (cause: unknown) =>
  new DesktopRunFailed({ message: `${what}: ${String(cause)}` });

/** Reads stdout to the end; an abort or the timeout kills the process. */
const collect = (running: Running, signal: AbortSignal | undefined) =>
  Effect.tryPromise({
    try: async () => {
      const kill = () => running.kill("SIGKILL");
      signal?.addEventListener("abort", kill, { once: true });
      void running.stderr?.pipeTo(new WritableStream()).catch(() => {});

      try {
        const [stdout] = await Promise.all([new Response(running.stdout).text(), running.exited]);

        return stdout;
      } finally {
        signal?.removeEventListener("abort", kill);
      }
    },
    catch: failed("agent-desktop's output could not be read"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: RUN_TIMEOUT,
      orElse: () =>
        Effect.sync(() => running.kill("SIGKILL")).pipe(
          Effect.andThen(Effect.fail(new DesktopRunFailed({ message: "agent-desktop timed out" })))
        ),
    })
  );

/** Inside the helper app, with responsibility disclaimed (macOS). */
export const helperRunner = Effect.gen(function* () {
  const helper = yield* ComputerUseHelper;

  return {
    run: (args, env, signal) =>
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* helper
            .spawn({ tool: "agent-desktop", args, env: { ...childEnv(), ...env } })
            .pipe(Effect.mapError((error) => new DesktopRunFailed({ message: error.message })));

          running.end();

          return yield* collect(running, signal);
        })
      ),
  } satisfies DesktopRunner;
});

/** The Host's own agent-desktop (Linux, Windows). */
export const directRunner = Effect.gen(function* () {
  const agentDesktop = yield* AgentDesktop;

  return {
    run: (args, env, signal) =>
      Effect.gen(function* () {
        const { binary } = yield* agentDesktop.current.pipe(
          Effect.mapError((error) => new DesktopRunFailed({ message: error.message }))
        );

        const running = yield* Effect.try({
          try: () =>
            Bun.spawn([binary, ...args], {
              env: { ...childEnv(), ...env },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "ignore",
            }),
          catch: failed("agent-desktop could not be started"),
        });

        return yield* collect(
          { stdout: running.stdout, exited: running.exited, kill: (s) => running.kill(s) },
          signal
        );
      }),
  } satisfies DesktopRunner;
});
