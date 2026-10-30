import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@polaris/ui";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { DEFAULT_SESSION_PREFS } from "../../../../shared/sessionPrefs.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostModel, hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { polaris } from "../../bridge.ts";
import { connectSettings, settingsStore } from "../store.ts";
import { SessionsPage } from "./SessionsPage.tsx";

let fake: FakeBridge;

let disconnect: () => void;

beforeEach(() => {
  fake = installFakeBridge();
  fake.refuse("settings.get", { code: "Unsupported", message: "not in this test" });
  disconnect = connectSettings(polaris());
  settingsStore.setState({
    sessions: { ...DEFAULT_SESSION_PREFS, workspaceAcceptBranch: { "mac/dotfiles": "current" } },
  });
});

afterEach(() => {
  cleanup();
  disconnect();
});

const mount = () => {
  const state: AppState = {
    ...initialState,
    hosts: [{ ...hostView("mac"), label: "Mac Studio" }],
    hostModels: { mac: hostModel([{ id: "polaris" }, { id: "dotfiles" }]) },
  };

  const store = createStore<AppState>(() => state);

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <SessionsPage />
      </TooltipProvider>
    </AppProvider>
  );

  const card = (title: string) => {
    const found = screen.getAllByRole("heading").find((h) => h.textContent === title);
    const section = found?.closest("section");

    if (section == null) throw new Error(`no card ${title}`);

    return within(section);
  };

  return { card };
};

test("While sessions run counts the notifications that are on, and a switch saves", () => {
  const { card } = mount();
  const running = card("While sessions run");

  expect(running.getByText("4 of 5 notifications on")).toBeTruthy();

  act(() => {
    fireEvent.click(running.getByRole("switch", { name: "When a session needs you" }));
  });

  expect(fake.sent("settings.setSessions")).toEqual([{ patch: { notifyNeedsYou: false } }]);
  expect(running.getByText("3 of 5 notifications on")).toBeTruthy();
});

test("a workspace that commits differently names its host, and × makes it follow again", () => {
  const { card } = mount();
  const accepting = card("Accepting work");

  expect(accepting.getByText("Mac Studio · overrides")).toBeTruthy();
  expect(accepting.getByText("1 workspace differs")).toBeTruthy();

  act(() => {
    fireEvent.click(accepting.getByRole("button", { name: "Remove the override for dotfiles" }));
  });

  expect(fake.sent("settings.setSessions")).toEqual([{ patch: { workspaceAcceptBranch: {} } }]);
  expect(accepting.getByText("Every workspace commits alike")).toBeTruthy();
});
