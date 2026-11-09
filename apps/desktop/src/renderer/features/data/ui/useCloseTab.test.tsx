import "../../../test/dom.testing.ts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import {
  dataSessionKey,
  dataTabsStore,
  openSqlTab,
  openTable,
  useDataTabs,
} from "../model/store.ts";
import { DATA_AT } from "../preview/scene.ts";
import { useCloseTab } from "./useCloseTab.ts";

afterEach(() => {
  cleanup();
  dataTabsStore.setState({ sessions: {}, shown: null });
});

const Probe = () => {
  useCloseTab(DATA_AT, useDataTabs(DATA_AT).active);

  return null;
};

const mount = () => {
  const store = createStore<AppState>(() => initialState);
  const commands = createCommandRegistry({ platform: "mac" });

  const connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  render(
    <AppProvider
      value={{ connection, navigation: createNavigation({ app: store, storage: null }), commands }}
    >
      <Probe />
    </AppProvider>
  );

  return commands;
};

const kinds = () =>
  (dataTabsStore.getState().sessions[dataSessionKey(DATA_AT)]?.tabs ?? []).map((t) => t.kind);

test("⌘W closes the open tab, not the window, until no tab is left", () => {
  const close = spyOn(window, "close").mockImplementation(() => undefined);

  act(() => {
    openTable("app", { schema: "public", name: "invoices" }, DATA_AT);
    openSqlTab("select 1", "app", DATA_AT);
  });

  const commands = mount();

  act(() => void commands.run("tab.close"));
  expect([kinds(), close.mock.calls.length]).toEqual([["table"], 0]);
  act(() => void commands.run("tab.close"));
  act(() => void commands.run("tab.close"));
  expect([kinds(), close.mock.calls.length]).toEqual([[], 1]);
  close.mockRestore();
});
