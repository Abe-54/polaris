/**
 * The Host's agent-desktop, under `~/.polaris/tools/agent-desktop/`. Nothing waits for it: the
 * first `current` that finds it missing starts the install in the background.
 */
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { paths } from "../../paths.ts";
import { runtimePlatform } from "../../platform/index.ts";
import { background, type Installer, type InstallPolicy, POLICY } from "../background.ts";
import {
  type InstallOptions,
  type InstalledAgentDesktop,
  installAgentDesktop,
  installedOnDisk,
} from "./install.ts";
import { AGENT_DESKTOP_VERSION } from "./pin.ts";

export { AGENT_DESKTOP_VERSION } from "./pin.ts";

export type { InstalledAgentDesktop } from "./install.ts";

export class AgentDesktopUnavailable extends Schema.TaggedError<AgentDesktopUnavailable>()(
  "AgentDesktopUnavailable",
  { message: Schema.String }
) {}

export type AgentDesktopInstaller = Installer<InstallOptions, InstalledAgentDesktop>;

const TOOL = {
  name: "agent-desktop",
  version: AGENT_DESKTOP_VERSION,
  ready: "later sessions get desktop control",
  unavailable: (message: string) => new AgentDesktopUnavailable({ message }),
};

export class AgentDesktop extends Context.Service<
  AgentDesktop,
  {
    /**
     * The installed binary, without waiting: while it is missing this fails at once and the
     * install runs in the background.
     */
    readonly current: Effect.Effect<InstalledAgentDesktop, AgentDesktopUnavailable>;
  }
>()("polaris/daemon/install/AgentDesktop") {
  /** Installs into `options().root`; tests pass their own installer and policy. */
  static readonly layerWith = (
    options: () => InstallOptions,
    installer: AgentDesktopInstaller = { onDisk: installedOnDisk, install: installAgentDesktop },
    policy: InstallPolicy = POLICY
  ) =>
    Layer.sync(AgentDesktop, () =>
      AgentDesktop.of({ current: background(TOOL, options, installer, policy) })
    );

  static readonly layer = AgentDesktop.layerWith(() => ({
    root: join(paths().root, "tools", "agent-desktop"),
    platform: runtimePlatform(),
  }));

  /** Tests and benches: a fixed install, or none. */
  static readonly layerAt = (installed: InstalledAgentDesktop | null) =>
    Layer.succeed(AgentDesktop)(
      AgentDesktop.of({
        current:
          installed === null
            ? Effect.fail(
                new AgentDesktopUnavailable({ message: "agent-desktop is not installed" })
              )
            : Effect.succeed(installed),
      })
    );
}
