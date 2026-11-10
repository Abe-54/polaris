/**
 * The Host's Simulator tools, expo-device-hub and agent-device (ADR 0099), under
 * `~/.polaris/tools/simulator/`. They install on first use, and only on a Host that can run
 * some platform's Simulators: elsewhere nothing is ever downloaded.
 */
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { SimulatorUnavailable } from "@polaris/protocol";
import { paths } from "../../paths.ts";
import { HostPlatform, runtimePlatformOf } from "../../platform/index.ts";
import { simulatorCapable } from "../../simulator/support.ts";
import { DEFAULT_POLICY, type Installer, type InstallPolicy, onDemand } from "../onDemand.ts";
import {
  type InstalledSimulatorTools,
  installedOnDisk,
  installSimulatorTools,
  type SimulatorToolsOptions,
} from "./install.ts";

import { bunRuntimeSource } from "./runtime.ts";

export { type InstalledSimulatorTools } from "./install.ts";

export { type BunRuntime, ownBun } from "./runtime.ts";

export { AGENT_DEVICE_VERSION, EXPO_DEVICE_HUB_VERSION, SIMULATOR_TOOLS_VERSION } from "./pin.ts";

export type SimulatorToolsInstaller = Installer<SimulatorToolsOptions, InstalledSimulatorTools>;

const unavailable = (message: string) => new SimulatorUnavailable({ message });

export class SimulatorTools extends Context.Service<
  SimulatorTools,
  {
    /** The installed tools without waiting: while missing, this fails and the install starts. */
    readonly current: Effect.Effect<InstalledSimulatorTools, SimulatorUnavailable>;
    /** The installed tools, waiting for the install a first use starts. */
    readonly ensure: Effect.Effect<InstalledSimulatorTools, SimulatorUnavailable>;
  }
>()("polaris/daemon/install/SimulatorTools") {
  /** Installs into `options().root`; tests pass their own installer and policy. */
  static readonly layerWith = (
    options: () => SimulatorToolsOptions,
    installer: SimulatorToolsInstaller = {
      onDisk: installedOnDisk,
      install: installSimulatorTools,
    },
    policy: InstallPolicy = DEFAULT_POLICY
  ) =>
    Layer.effect(
      SimulatorTools,
      Effect.gen(function* () {
        const facts = yield* HostPlatform;

        if (!simulatorCapable(facts)) {
          const never = Effect.fail(unavailable("this Host can't run Simulators"));

          return SimulatorTools.of({ current: never, ensure: never });
        }

        return SimulatorTools.of(
          onDemand(options, installer, policy, {
            unavailable,
            unresolved: "can't tell where to install the Simulator's tools",
            installing: "The Simulator's tools are installing",
            failed: (reason) => `Installing the Simulator's tools failed (${reason})`,
          })
        );
      })
    );

  /** A sealed Daemon's Bun goes beside the tools, in `~/.polaris/tools/bun/` (ADR 0108). */
  static readonly layer = Layer.unwrap(
    Effect.map(HostPlatform, (facts) => {
      const bun = bunRuntimeSource({
        root: join(paths().root, "tools", "bun"),
        platform: runtimePlatformOf(facts),
      });

      return SimulatorTools.layerWith(() => ({
        root: join(paths().root, "tools", "simulator"),
        bun,
      }));
    })
  );
}
