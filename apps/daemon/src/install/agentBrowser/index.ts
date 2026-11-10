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
import { DEFAULT_POLICY, type Installer, type InstallPolicy, onDemand } from "../onDemand.ts";

export { AGENT_BROWSER_VERSION } from "./pin.ts";

export type { InstalledAgentBrowser } from "./install.ts";

export class AgentBrowserUnavailable extends Schema.TaggedError<AgentBrowserUnavailable>()(
  "AgentBrowserUnavailable",
  { message: Schema.String }
) {}

export type AgentBrowserInstaller = Installer<InstallOptions, InstalledAgentBrowser>;

export type { InstallPolicy } from "../onDemand.ts";

const background = (
  options: () => InstallOptions,
  installer: AgentBrowserInstaller,
  policy: InstallPolicy
) =>
  onDemand(options, installer, policy, {
    unavailable: (message) => new AgentBrowserUnavailable({ message }),
    unresolved: "can't tell which agent-browser build this Host needs",
    installing: `agent-browser ${AGENT_BROWSER_VERSION} is installing; later sessions get the Browser`,
    failed: (reason) => `installing agent-browser failed (${reason}); trying again`,
  }).current;

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
    policy: InstallPolicy = DEFAULT_POLICY
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
