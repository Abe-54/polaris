/**
 * The shared install lifecycle of every tool here: nothing installs until a caller asks, one
 * install at a time is shared by every caller, and each attempt is bounded and retried.
 */
import { Effect } from "effect";

export interface InstallPolicy {
  /** Each attempt is cancelled after this; a stalled download can't hold the install forever. */
  readonly attemptTimeoutMs: number;
  /** The waits before each retry; after the last attempt fails, the next caller starts again. */
  readonly retryDelaysMs: ReadonlyArray<number>;
}

export const DEFAULT_POLICY: InstallPolicy = {
  attemptTimeoutMs: 10 * 60_000,
  retryDelaysMs: [5_000, 30_000],
};

export interface Installer<Options extends { readonly signal?: AbortSignal }, Installed> {
  readonly onDisk: (options: Options) => Promise<Installed | null>;
  readonly install: (options: Options) => Promise<Installed>;
}

/** What a caller is told while the tool is missing, as the tool's own error. */
export interface OnDemandMessages<E> {
  readonly unavailable: (message: string) => E;
  /** The options could not be resolved (an unknown platform). */
  readonly unresolved: string;
  readonly installing: string;
  readonly failed: (reason: string) => string;
}

const attempts = <Options extends { readonly signal?: AbortSignal }, Installed>(
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

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * `current` never waits: while the tool is missing it fails at once and starts the install in
 * the background. `ensure` starts or joins that install and waits for it.
 */
export const onDemand = <Options extends { readonly signal?: AbortSignal }, Installed, E>(
  options: () => Options,
  installer: Installer<Options, Installed>,
  policy: InstallPolicy,
  messages: OnDemandMessages<E>
) => {
  let ready: Installed | null = null;
  let installing: Promise<Installed> | null = null;
  let failure: string | null = null;

  const start = (resolved: Options): Promise<Installed> => {
    installing ??= attempts(installer.install, resolved, policy).then(
      (installed) => (ready = installed),
      (cause: Error) => {
        failure = cause.message;
        installing = null;
        throw cause;
      }
    );

    return installing;
  };

  /** The tool if it is on disk, and the resolved options to install it with otherwise. */
  const lookup = Effect.gen(function* () {
    const resolved = yield* Effect.try({
      try: options,
      catch: () => messages.unavailable(messages.unresolved),
    });

    const found = yield* Effect.tryPromise({
      try: () => installer.onDisk(resolved),
      catch: (cause) => messages.unavailable(reasonOf(cause)),
    });

    if (found !== null) ready = found;

    return { installed: found, resolved };
  });

  const current: Effect.Effect<Installed, E> = Effect.gen(function* () {
    if (ready !== null) return ready;
    const { installed, resolved } = yield* lookup;

    if (installed !== null) return installed;

    const failed = installing === null ? failure : null;
    // The install runs on; its outcome is read by the next caller.
    start(resolved).catch(() => {});

    return yield* Effect.fail(
      messages.unavailable(failed === null ? messages.installing : messages.failed(failed))
    );
  });

  const ensure: Effect.Effect<Installed, E> = Effect.gen(function* () {
    if (ready !== null) return ready;
    const { installed, resolved } = yield* lookup;

    if (installed !== null) return installed;

    return yield* Effect.tryPromise({
      try: () => start(resolved),
      catch: (cause) => messages.unavailable(messages.failed(reasonOf(cause))),
    });
  });

  return { current, ensure };
};
