/** About on fixture Updates: every reachable phase and a fake-only interactive flow. */
import { DeveloperMode, WorkspaceId } from "@polaris/protocol";
import { Schema } from "effect";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { AppEvent, PolarisApi } from "../../../../../shared/api.ts";
import type { AppUpdateView } from "../../../../../shared/appUpdates.ts";
import { App } from "../../../../app/App.tsx";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { createNavigation } from "../../../../routes/navigation.ts";
import { type AppState, type Connection, initialState } from "../../../../store/store.ts";
import { standInBridge } from "../../../bridge.ts";
import { settingsCommands } from "../../actions.ts";
import { connectUpdates, updatesStore } from "../store.ts";
import { HOSTS, MODELS } from "../../../needs-you/preview/fixtures.ts";
import { hostDeveloperModesStore } from "../../hostDeveloperModes.ts";
import { settingsStore } from "../../store.ts";

const PHASES: ReadonlyArray<AppUpdateView["phase"]> = [
  "idle",
  "checking",
  "current",
  "downloading",
  "ready",
  "blocked",
  "failed",
];

const Enabled = Schema.Struct({ enabled: Schema.Boolean });

/** `#updates/developer` and `#updates/developer-dev`: About's Developer Mode on three Hosts. */
const DEVELOPER_SCENES = new Set(["developer", "developer-dev"]);

const developerMode = (stored: boolean, leases: number, workspace: string | null) =>
  DeveloperMode.make({
    stored,
    leases,
    fromSource: false,
    effective: stored || leases > 0,
    polarisWorkspaceId: workspace === null ? null : WorkspaceId.make(workspace),
    polarisWorkspaceSource: workspace === null ? null : "remote",
  });

const developerModes = (dev: boolean) => ({
  local: developerMode(false, dev ? 1 : 0, "w-polaris"),
  "linux-vm": developerMode(false, dev ? 1 : 0, null),
  pi: developerMode(false, dev ? 1 : 0, null),
});

const fixtureBridge = (hash: string): PolarisApi => {
  const scene = hash.replace(/^#updates\//, "");

  let view: AppUpdateView = {
    phase: PHASES.find((phase) => phase === scene) ?? "idle",
    version: "0.4.0",
    availableVersion: scene === "ready" ? "0.5.0" : null,
    automatic: scene !== "off",
    lastCheckedAt: Date.now() - 2 * 60 * 60_000,
    installId: "58baf1dc-3772-4353-86b3-3a8a49219521",
    osVersion: "26.1",
    arch: "arm64",
    supported: true,
  };

  const listeners = new Set<(event: AppEvent) => void>();

  const publish = (patch: Partial<AppUpdateView>) => {
    view = { ...view, ...patch };

    for (const listener of listeners) listener({ kind: "updates", updates: view });
  };

  return {
    request: async (method, input) => {
      let value: AppUpdateView | null = null;

      switch (method) {
        case "updates.get":
          value = view;
          break;
        case "updates.setAutomatic":
          publish({ automatic: Schema.decodeUnknownSync(Enabled)(input).enabled });
          value = view;
          break;
        case "updates.check":
          publish({ phase: "checking" });
          setTimeout(() => publish({ phase: "downloading" }), 250);
          setTimeout(
            () => publish({ phase: "ready", availableVersion: "0.5.0", lastCheckedAt: Date.now() }),
            500
          );
          value = view;
          break;
        case "updates.restart":
          publish({
            phase: "current",
            version: view.availableVersion ?? view.version,
            availableVersion: null,
          });
          break;
        case "updates.showInFinder":
          break;
        case "developerMode.get":
        case "developerMode.set":
        case "developerMode.setWorkspace": {
          const { hostKey } = Schema.decodeUnknownSync(Schema.Struct({ hostKey: Schema.String }))(
            input
          );
          // SAFETY: the developerMode methods answer a DeveloperMode.

          return { ok: true, value: developerModes(false)[hostKey as "local"] as never };
        }

        default:
          return { ok: false, error: { code: "Unsupported", message: "preview" } };
      }
      // SAFETY: each handled fixture method returns its documented view or null output.

      return { ok: true, value: value as never };
    },
    subscribe: () => () => undefined,
    onAppEvent: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
};

export const mountUpdatesPreview = (root: HTMLElement, hash: string) => {
  const scene = hash.replace(/^#updates\//, "");
  const developer = DEVELOPER_SCENES.has(scene);

  const store = createStore<AppState>(() =>
    developer ? { ...initialState, hosts: HOSTS, hostModels: MODELS } : initialState
  );

  if (developer) {
    settingsStore.setState({ developmentBuild: scene === "developer-dev" });
    hostDeveloperModesStore.setState(developerModes(scene === "developer-dev"), true);
  }

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });
  const api = fixtureBridge(hash);
  standInBridge(api);
  updatesStore.setState({ view: null, problem: null });
  connectUpdates(api);
  navigation.actions.openSettings("about");
  const commands = createCommandRegistry({ platform: "mac" });
  commands.register(settingsCommands(navigation.actions));
  createRoot(root).render(<App value={{ connection, navigation, commands }} />);

  return connection.setDensity;
};
