/**
 * The install every tool here shares: nothing waits for it. The first caller that finds the tool
 * missing starts one bounded, retried install in the background and fails at once.
 */
import { Effect } from "effect";

export interface Installer<Options, Installed> {
  readonly onDisk: (options: Options) => Promise<Installed | null>;
  readonly install: (options: Options & { readonly signal: AbortSignal }) => Promise<Installed>;
}

export interface InstallPolicy {
  /** Each attempt is cancelled after this; a stalled download can't hold the install forever. */
  readonly attemptTimeoutMs: number;
  /** The waits before each retry; after the last attempt fails, the next caller starts again. */
  readonly retryDelaysMs: ReadonlyArray<number>;
}

export const POLICY: InstallPolicy = {
  attemptTimeoutMs: 10 * 60_000,
  retryDelaysMs: [5_000, 30_000],
};

export interface Tool<E> {
  /** The tool and its pinned version, as messages name it: `agent-browser 0.41.0`. */
  readonly name: string;
  readonly version: string;
  /** What a session gets once it is installed, ending the "is installing" message. */
  readonly ready: string;
  readonly unavailable: (message: string) => E;
}

const attempts = <Options, Installed>(
  install: Installer<Options, Installed>["install"],
  resolved: Options,
  policy: InstallPolicy,
  delays: ReadonlyArray<number> = policy.retryDelaysMs
): Promise<Installed> => {
  const signal = AbortSignal.timeout(policy.attemptTimeoutMs);
  const minutes = Math.round(policy.attemptTimeoutMs / 60_000);

  return install({ ...resolved, signal }).catch(async (cause: Error) => {
    const [delay, ...rest] = delays;
    const reason = signal.aborted ? new Error(`timed out after ${minutes} min`) : cause;

    if (delay === undefined) throw reason;
    await Bun.sleep(delay);

    return attempts(install, resolved, policy, rest);
  });
};

/** One install at a time, shared by every caller, each attempt bounded and retried. */
export const background = <Options, Installed, E>(
  tool: Tool<E>,
  options: () => Options,
  installer: Installer<Options, Installed>,
  policy: InstallPolicy
): Effect.Effect<Installed, E> => {
  let ready: Installed | null = null;
  let installing: Promise<void> | null = null;
  let failure: string | null = null;

  const start = (resolved: Options) => {
    installing ??= attempts(installer.install, resolved, policy).then(
      (installed) => {
        ready = installed;
      },
      (cause: Error) => {
        failure = cause.message;
        installing = null;
      }
    );
  };

  return Effect.gen(function* () {
    if (ready !== null) return ready;

    const resolved = yield* Effect.try({
      try: options,
      catch: () => tool.unavailable(`can't tell which ${tool.name} build this Host needs`),
    });

    const found = yield* Effect.tryPromise({
      try: () => installer.onDisk(resolved),
      catch: (cause) => tool.unavailable(cause instanceof Error ? cause.message : "no build"),
    });

    if (found !== null) return (ready = found);
    const failed = installing === null ? failure : null;
    start(resolved);

    return yield* Effect.fail(
      tool.unavailable(
        failed === null
          ? `${tool.name} ${tool.version} is installing; ${tool.ready}`
          : `installing ${tool.name} failed (${failed}); trying again`
      )
    );
  });
};
