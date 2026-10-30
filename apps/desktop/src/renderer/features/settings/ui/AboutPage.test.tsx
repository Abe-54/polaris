import "../../../test/dom.testing.ts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { HostView } from "../../../../shared/api.ts";
import type { AppUpdateView } from "../../../../shared/appUpdates.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { updatesStore } from "../updates/store.ts";
import { AboutPage } from "./AboutPage.tsx";

afterEach(() => {
  cleanup();
  updatesStore.setState({ view: null, problem: null, changing: false });
});

const view = (patch: Partial<AppUpdateView> = {}): AppUpdateView => ({
  phase: "current",
  version: "0.5.0",
  availableVersion: null,
  automatic: true,
  lastCheckedAt: null,
  installId: "7c1e0000-0000-0000-0000-00000000a40b",
  osVersion: "27.0",
  platform: "darwin",
  arch: "arm64",
  supported: true,
  ...patch,
});

/** A connected host whose daemon reports `daemonVersion`. */
const daemonHost = (key: string, daemonVersion: string): HostView => {
  const base = hostView(key);

  return {
    ...base,
    status: {
      ...base.status,
      // SAFETY: the page reads only daemonVersion from HostInfo.
      host: { daemonVersion } as NonNullable<HostView["status"]["host"]>,
    },
  };
};

const mount = (updates: AppUpdateView, hosts: ReadonlyArray<HostView> = []) => {
  updatesStore.setState({ view: updates });
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
      <AboutPage />
    </AppProvider>
  );

  return navigation;
};

test.each(["0.5.0", "1.2.3-beta.4"])(
  "the title names the version the running app reports: %s",
  (version) => {
    mount(view({ version }));

    expect(screen.getByTestId("about-version").textContent).toBe(`Polaris ${version}`);
  }
);

test("a daemon older than the app says it can upgrade, and the aside counts the current ones", () => {
  const navigation = mount(view({ version: "0.5.0" }), [
    daemonHost("studio", "0.5.0"),
    daemonHost("pi", "0.4.2"),
    hostView("vm", "offline"),
  ]);

  const card = within(screen.getByTestId("about-daemons"));

  expect(card.getAllByTestId("daemon-version").map((el) => el.textContent)).toEqual([
    "0.5.0",
    "0.4.2 · upgrade",
  ]);
  expect(card.getByText("1 of 2 current")).not.toBeNull();
  expect(card.getByText("Not connected")).not.toBeNull();

  fireEvent.click(card.getByRole("button", { name: "Open hosts" }));
  expect(navigation.store.getState().settings?.section).toBe("hosts");
});

test("the ready state offers Restart to update, and Check now waits until after the restart", () => {
  mount(view({ phase: "ready", availableVersion: "0.5.1", lastCheckedAt: 0 }));

  expect(screen.getByRole("button", { name: "Restart to update" })).not.toBeNull();
  expect(screen.getByRole("button", { name: "Check now" }).hasAttribute("disabled")).toBe(true);
});

test("with automatic checks off, the install ID is not sent", () => {
  mount(view({ automatic: false }));

  const fields = within(screen.getByTestId("update-fields"));

  expect(fields.getByText("Not sent while automatic checks are off")).not.toBeNull();
  expect(fields.queryByText(/7c1e/)).toBeNull();
});
