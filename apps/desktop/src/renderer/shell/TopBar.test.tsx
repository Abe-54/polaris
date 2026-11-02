import "../test/dom.testing.ts";
// The app loads its slots first; shell/commands.ts reaches them through a cycle.
import "../app/slots.tsx";
import { WorkspaceId } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../routes/commands.ts";
import { hostModel, hostView, workspaces } from "../routes/fixtures.testing.ts";
import { createNavigation } from "../routes/navigation.ts";
import { shortcutLabel } from "../routes/topBar.ts";
import { type AppState, type Connection, initialState } from "../store/store.ts";
import { shellCommands } from "./commands.ts";
import { AppProvider } from "./hooks.ts";
import { TopBar } from "./TopBar.tsx";

afterEach(cleanup);

const page = () => within(document.body);

/** The real top bar on a remote Host ("studio") and this Mac, two Workspaces each. */
const mount = () => {
  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [hostView("local"), hostView("studio")],
    hostModels: {
      local: hostModel(workspaces("local", 2)),
      studio: hostModel(workspaces("studio", 2)),
    },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  commands.register(shellCommands({ connection, navigation, dark: () => false }));
  render(
    <AppProvider value={{ connection, navigation, commands }}>
      <TooltipProvider>
        <TopBar />
      </TooltipProvider>
    </AppProvider>
  );

  return { navigation };
};

/** Each Workspace chip's name and its ⌃N, in bar order (Host names are `data-host` buttons). */
const chipText = () =>
  [
    ...page()
      .getByRole("navigation", { name: "Workspaces" })
      .querySelectorAll("button:not([data-host])"),
  ].flatMap((button) => {
    const text = button.textContent ?? "";

    return /local\d|studio\d/.test(text) ? [text] : [];
  });

test("clicking a Host's name collapses its chips and shifts ⌃N onto the visible ones", () => {
  const { navigation } = mount();
  const studio = page().getByRole("button", { expanded: true, name: /studio/ });

  act(() =>
    navigation.actions.selectWorkspace({
      hostKey: "local",
      workspaceId: WorkspaceId.make("local1"),
    })
  );

  expect(chipText()).toEqual([
    `studio0${shortcutLabel(0)}`,
    `studio1${shortcutLabel(1)}`,
    `local0${shortcutLabel(2)}`,
    `local1${shortcutLabel(3)}`,
  ]);

  act(() => {
    fireEvent.click(studio);
  });

  expect(studio.getAttribute("aria-expanded")).toBe("false");
  expect(chipText()).toEqual([`local0${shortcutLabel(0)}`, `local1${shortcutLabel(1)}`]);
  // The collapsed name still counts its Workspaces.
  expect(page().getByTestId("collapsed-studio").textContent).toBe("2");

  act(() => navigation.actions.selectShortcut(0));
  expect(String(navigation.current().workspaceId)).toBe("local0");

  act(() => {
    fireEvent.click(studio);
  });
  expect(chipText()).toHaveLength(4);
});

test("a collapsed Host keeps the open chip, without a ⌃N", () => {
  const { navigation } = mount();

  act(() =>
    navigation.actions.selectWorkspace({
      hostKey: "studio",
      workspaceId: WorkspaceId.make("studio1"),
    })
  );
  act(() => {
    fireEvent.click(page().getByRole("button", { expanded: true, name: /studio/ }));
  });

  expect(chipText()).toEqual(["studio1", `local0${shortcutLabel(0)}`, `local1${shortcutLabel(1)}`]);
});
