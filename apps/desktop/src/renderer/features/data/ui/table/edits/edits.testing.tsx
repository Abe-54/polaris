/** The Table tab's edits harness: the real grid, store and fixture api in happy-dom. */
import "../../../../../test/dom.testing.ts";
import { DataWriteResult } from "@polaris/protocol";
import { Toaster, TooltipProvider } from "@polaris/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../../../routes/commands.ts";
import { createNavigation } from "../../../../../routes/navigation.ts";
import { AppProvider } from "../../../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../../../store/store.ts";
import type { CommitEditsInput, DataApi } from "../../../data/api.ts";
import { DataLayer } from "../../../data/hooks.tsx";
import { dataTabsStore, useDataTabs } from "../../../model/store.ts";
import { type DataTab, tableTabId } from "../../../model/tabs.ts";
import { fixtureDataApi } from "../../../preview/fixtureApi.ts";
import { FIXTURE_INVOICES, FIXTURE_SESSIONS, FIXTURE_SOURCES } from "../../../preview/fixtures.ts";
import { dataHost } from "../../../preview/scene.ts";
import { ConnectionBar } from "../../ConnectionBar.tsx";
import { TableTabBody } from "../../TableTab.tsx";
import { TabStrip } from "../../TabStrip.tsx";
import { tableViews } from "../state.ts";
import { editsStore } from "./store.ts";

const SIZES = { offsetWidth: 1400, offsetHeight: 800 } as const;

const originals = Object.keys(SIZES).map(
  (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const
);

/** Gives happy-dom a viewport and resets the stores after each test. */
export const installGridHarness = () => {
  // happy-dom has no layout: give every element the viewport the virtualizer measures.
  beforeAll(() => {
    for (const [key, size] of Object.entries(SIZES))
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => size });
  });

  afterAll(() => {
    for (const [key, descriptor] of originals)
      if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, key);
      else Object.defineProperty(HTMLElement.prototype, key, descriptor);
  });

  afterEach(() => {
    cleanup();
    tableViews.setState({}, true);
    dataTabsStore.setState({ sessions: {}, shown: null });
    editsStore.setState({ tabs: {}, closing: null });
  });
};

export const host = dataHost();

export const at = { hostKey: host.key, sessionId: FIXTURE_SESSIONS.overdue.id };

export const INVOICES = { schema: "public", name: "invoices" };

export const tabOn = (sourceId: string, name = "invoices"): Extract<DataTab, { kind: "table" }> => {
  const ref = { schema: "public", name };

  return { kind: "table", id: tableTabId(sourceId, ref), sourceId, table: name, ref };
};

/** A fixture Host that records each `data.edits.commit`. */
export const recording = (base: DataApi = fixtureDataApi()) => {
  const sent: Array<CommitEditsInput> = [];

  const api: DataApi = {
    ...base,
    commitEdits: async (_at, input) => {
      sent.push(input);

      return {
        ok: true,
        value: new DataWriteResult({ queryId: "q", affected: input.edits.length, elapsedMs: 3 }),
      };
    },
  };

  return { api, sent };
};

const Tabs = () => <TabStrip at={at} state={useDataTabs(at)} />;

export const mount = (api: DataApi, tab = tabOn("app"), extra: "strip" | "bar" | null = null) => {
  const store = createStore<AppState>(() => ({ ...initialState, density: "calm", hosts: [host] }));
  const commands = createCommandRegistry({ platform: "mac" });

  // Data mode is showing, as the shell says when ⌘4 is up.
  commands.provide(() => ({ keys: ["mode.data"] }));

  render(
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation: createNavigation({ app: store, storage: null }),
        commands,
      }}
    >
      <TooltipProvider>
        <Toaster />
        <DataLayer api={api}>
          {extra === "strip" ? <Tabs /> : null}
          {extra === "bar" ? (
            <ConnectionBar at={at} hostKey={host.key} workspaceId="w" active={tab} />
          ) : null}
          <TableTabBody at={at} tab={tab} />
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return commands;
};

export const footer = () => screen.getByTestId("data-table-footer").textContent ?? "";

export const cell = (row: number, col: number) => {
  const found = document.querySelector<HTMLElement>(`[data-row="${row}"] [data-col="${col}"]`);

  if (found === null) throw new Error(`no cell at ${row}, ${col}`);

  return found;
};

export const grid = () => screen.getByTestId("data-grid");

export const loaded = () =>
  waitFor(() => expect(footer()).toContain(`${FIXTURE_INVOICES.length} rows`));

/** Selects the cell, presses ↵ (or another key) and types `value` into its editor. */
export const editCell = (row: number, col: number, value: string, key = "Enter") => {
  fireEvent.mouseDown(cell(row, col), { button: 0 });
  fireEvent.keyDown(grid(), { key });
  const field = screen.getByTestId("data-cell-editor-field");

  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: "Enter" });
};

export const ledger = FIXTURE_SOURCES.find((s) => s.name === "ledger");
