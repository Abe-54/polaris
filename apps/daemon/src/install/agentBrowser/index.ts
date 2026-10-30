/**
 * The Host's agent-browser (ADR 0092), under `~/.polaris/tools/agent-browser/`. Nothing waits
 * for it: the first `current` that finds it missing starts the install in the background.
 */
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { paths } from "../../paths.ts";
import { runtimePlatform } from "../../platform/index.ts";
import {
  type InstallOptions,
  type InstalledAgentBrowser,
  installAgentBrowser,
  installedOnDisk,
} from "./install.ts";
import { AGENT_BROWSER_VERSION } from "./pin.ts";

export { AGENT_BROWSER_VERSION } from "./pin.ts";

export type { InstalledAgentBrowser } from "./install.ts";

export class AgentBrowserUnavailable extends Schema.TaggedError<AgentBrowserUnavailable>()(
  "AgentBrowserUnavailable",
  { message: Schema.String }
) {}

export interface AgentBrowserInstaller {
  readonly onDisk: (options: InstallOptions) => Promise<InstalledAgentBrowser | null>;
  readonly install: (options: InstallOptions) => Promise<InstalledAgentBrowser>;
}

export interface InstallPolicy {
  /** Each attempt is cancelled after this; a stalled download can't hold the install forever. */
  readonly attemptTimeoutMs: number;
  /** The waits before each retry; after the last attempt fails, the next caller starts again. */
  readonly retryDelaysMs: ReadonlyArray<number>;
}

const POLICY: InstallPolicy = { attemptTimeoutMs: 10 * 60_000, retryDelaysMs: [5_000, 30_000] };

const attempts = (
  install: AgentBrowserInstaller["install"],
  resolved: InstallOptions,
  policy: InstallPolicy,
  delays: ReadonlyArray<number> = policy.retryDelaysMs
): Promise<InstalledAgentBrowser> => {
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
const background = (
  options: () => InstallOptions,
  installer: AgentBrowserInstaller,
  policy: InstallPolicy
) => {
  let ready: InstalledAgentBrowser | null = null;
  let installing: Promise<void> | null = null;
  let failure: string | null = null;

  const start = (resolved: InstallOptions) => {
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

  const unavailable = (message: string) => new AgentBrowserUnavailable({ message });

  return Effect.gen(function* () {
    if (ready !== null) return ready;

    const resolved = yield* Effect.try({
      try: options,
      catch: () => unavailable("can't tell which agent-browser build this Host needs"),
    });

    const found = yield* Effect.tryPromise({
      try: () => installer.onDisk(resolved),
      catch: (cause) => unavailable(cause instanceof Error ? cause.message : "no build"),
    });

    if (found !== null) return (ready = found);
    const failed = installing === null ? failure : null;
    start(resolved);

    return yield* unavailable(
      failed === null
        ? `agent-browser ${AGENT_BROWSER_VERSION} is installing; later sessions get the Browser`
        : `installing agent-browser failed (${failed}); trying again`
    );
  });
};

export class AgentBrowser extends Context.Service<
  AgentBrowser,
  {
    /**
     * The installed binary, without waiting: while it is missing this fails at once and the
     * install runs in the background.
     */
    readonly current: Effect.Effect<InstalledAgentBrowser, AgentBrowserUnavailable>;
  }
>()("polaris/daemon/install/AgentBrowser") {
  /** Installs into `options().root`; tests pass their own installer and policy. */
  static readonly layerWith = (
    options: () => InstallOptions,
    installer: AgentBrowserInstaller = { onDisk: installedOnDisk, install: installAgentBrowser },
    policy: InstallPolicy = POLICY
  ) =>
    Layer.sync(AgentBrowser, () =>
      AgentBrowser.of({ current: background(options, installer, policy) })
    );

  static readonly layer = AgentBrowser.layerWith(() => ({
    root: join(paths().root, "tools", "agent-browser"),
    platform: runtimePlatform(),
  }));

  /** Tests and benches: a fixed install, or none. */
  static readonly layerAt = (installed: InstalledAgentBrowser | null) =>
    Layer.succeed(AgentBrowser)(
      AgentBrowser.of({
        current:
          installed === null
            ? Effect.fail(
                new AgentBrowserUnavailable({ message: "agent-browser is not installed" })
              )
            : Effect.succeed(installed),
      })
    );
}
