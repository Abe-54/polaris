import "../../test/dom.testing.ts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { DeveloperMode } from "@polaris/protocol";
import { createStore } from "zustand/vanilla";
import type { HostView, PolarisApi } from "../../../shared/api.ts";
import { DEFAULT_SESSION_PREFS } from "../../../shared/sessionPrefs.ts";
import { createCommandRegistry } from "../../routes/commands.ts";
import { hostView } from "../../routes/fixtures.testing.ts";
import { createNavigation } from "../../routes/navigation.ts";
import { AppProvider } from "../../shell/hooks.ts";
import { type AppState, initialState } from "../../store/store.ts";
import { standInBridge } from "../bridge.ts";
import { DeveloperModePublisher, developerModes } from "./developerModeSync.ts";
import { settingsStore } from "./store.ts";

afterEach(() => {
  cleanup();
  standInBridge(null);
  developerModes.setState({}, true);
});

const capable = (key: string, epoch: number): HostView => {
  const base = hostView(key);

  return { ...base, status: { ...base.status, capabilities: ["developer-mode"], epoch } };
};

/** Fake Daemons: each Host's stored setting, read and written through the bridge. */
const fakeHosts = (stored: Record<string, boolean>) => {
  const mode = (hostKey: string) =>
    DeveloperMode.make({
      stored: stored[hostKey] ?? false,
      leases: 0,
      fromSource: false,
      effective: stored[hostKey] ?? false,
      polarisWorkspaceId: null,
      polarisWorkspaceSource: null,
    });

  standInBridge({
    request: (method, input) => {
      // SAFETY: both requests carry hostKey, and set carries enabled.
      const { hostKey, enabled } = input as { hostKey: string; enabled?: boolean };

      if (method === "developerMode.set") stored[hostKey] = enabled ?? false;

      // SAFETY: the Publisher sends only developerMode.get and .set, which answer a DeveloperMode.
      return Promise.resolve({ ok: true, value: mode(hostKey) }) as never;
    },
    subscribe: () => () => undefined,
    onAppEvent: () => () => undefined,
  } satisfies PolarisApi);
};

const publish = (hosts: ReadonlyArray<HostView>, enabled: boolean, developmentBuild: boolean) => {
  settingsStore.setState({
    sessions: { ...DEFAULT_SESSION_PREFS, developerMode: enabled },
    version: "0.9.0",
    developmentBuild,
  });
  const store = createStore<AppState>(() => ({ ...initialState, hosts }));
  const navigation = createNavigation({ app: store, storage: null });

  render(
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation,
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <DeveloperModePublisher />
    </AppProvider>
  );
};

test("the release app writes the switch to every connected Host whose setting differs", async () => {
  const stored = { studio: false, pi: true };
  fakeHosts(stored);

  publish([capable("studio", 1), capable("pi", 2), hostView("vm", "offline")], true, false);

  await waitFor(() => expect(stored).toEqual({ studio: true, pi: true }));
});

test("Polaris Dev only reads each Host, leaving the stored setting as it was", async () => {
  const stored = { studio: false };
  fakeHosts(stored);

  publish([capable("studio", 3)], true, true);

  await waitFor(() => expect(developerModes.getState().studio?.kind).toBe("mode"));
  expect(stored).toEqual({ studio: false });
});

test("a Daemon without Developer Mode is marked as needing a newer one", () => {
  fakeHosts({});

  publish([hostView("old")], true, false);

  expect(developerModes.getState().old).toEqual({ kind: "older-daemon" });
});
