import "../../../../../test/dom.testing.ts";
import { DataSource, DataWriteResult, TableDetail } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../../../routes/commands.ts";
import { createNavigation } from "../../../../../routes/navigation.ts";
import { AppProvider } from "../../../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../../../store/store.ts";
import type { CommitEditsInput, DataApi } from "../../../data/api.ts";
import { DataLayer } from "../../../data/hooks.tsx";
import { NO_KEY } from "../../../grid/editors.ts";
import { cellOf } from "../../../grid/value.ts";
import { dataTabsStore, openTable, useDataTabs } from "../../../model/store.ts";
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

// happy-dom has no layout: give every element the viewport the virtualizer measures.
beforeAll(() => {
  for (const [key, size] of Object.entries(SIZES))
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => size });
});

afterAll(() => {
  for (const [key, descriptor] of originals)
    if (descriptor !== undefined) Object.defineProperty(HTMLElement.prototype, key, descriptor);
});

afterEach(() => {
  cleanup();
  tableViews.setState({}, true);
  dataTabsStore.setState({ sessions: {}, shown: null });
  editsStore.setState({ tabs: {}, closing: null });
});

const host = dataHost();

const at = { hostKey: host.key, sessionId: FIXTURE_SESSIONS.overdue.id };

const INVOICES = { schema: "public", name: "invoices" };

const tabOn = (sourceId: string, name = "invoices"): Extract<DataTab, { kind: "table" }> => {
  const ref = { schema: "public", name };

  return { kind: "table", id: tableTabId(sourceId, ref), sourceId, table: name, ref };
};

/** A fixture Host that records each `data.edits.commit`. */
const recording = (base: DataApi = fixtureDataApi()) => {
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

const mount = (api: DataApi, tab = tabOn("app"), extra: "strip" | "bar" | null = null) => {
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

const footer = () => screen.getByTestId("data-table-footer").textContent ?? "";

const cell = (row: number, col: number) => {
  const found = document.querySelector<HTMLElement>(`[data-row="${row}"] [data-col="${col}"]`);

  if (found === null) throw new Error(`no cell at ${row}, ${col}`);

  return found;
};

const grid = () => screen.getByTestId("data-grid");

const loaded = () => waitFor(() => expect(footer()).toContain(`${FIXTURE_INVOICES.length} rows`));

/** Selects the cell, presses ↵ (or another key) and types `value` into its editor. */
const editCell = (row: number, col: number, value: string, key = "Enter") => {
  fireEvent.mouseDown(cell(row, col), { button: 0 });
  fireEvent.keyDown(grid(), { key });
  const field = screen.getByTestId("data-cell-editor-field");

  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: "Enter" });
};

test("↵ edits a cell; ↵ again stages it in tan and the footer counts it; ⌘Z takes it back", async () => {
  mount(recording().api);
  await loaded();

  editCell(0, 1, "INV-9999");
  expect(cell(0, 1).dataset["staged"]).toBe("true");
  expect(cell(0, 1).textContent).toBe("INV-9999");
  expect(footer()).toContain("1 change staged · 1 row");

  editCell(1, 1, "INV-9998", "F2");
  expect(footer()).toContain("2 changes staged · 2 rows");

  fireEvent.keyDown(grid(), { key: "z", metaKey: true });
  expect(footer()).toContain("1 change staged · 1 row");
  expect(cell(1, 1).dataset["staged"]).toBeUndefined();
});

test("esc puts the cell back, and an invalid value says why without staging", async () => {
  mount(recording().api);
  await loaded();

  fireEvent.mouseDown(cell(0, 4), { button: 0 });
  fireEvent.keyDown(grid(), { key: "Enter" });
  const field = screen.getByTestId("data-cell-editor-field");

  fireEvent.change(field, { target: { value: "lots" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.getByTestId("data-cell-editor-note").textContent).toBe("Not a number");

  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByTestId("data-cell-editor")).toBeNull();
  expect(screen.queryByTestId("data-staged")).toBeNull();
});

test("NULL is a choice in the editor of a nullable column, not typed text", async () => {
  mount(recording().api);
  await loaded();
  const row = FIXTURE_INVOICES.findIndex((r) => r[5] !== null);

  fireEvent.mouseDown(cell(row, 5), { button: 0 });
  fireEvent.keyDown(grid(), { key: "Enter" });
  fireEvent.click(screen.getByTestId("data-cell-editor-null"));
  fireEvent.keyDown(screen.getByTestId("data-cell-editor-field"), { key: "Enter" });

  expect(cell(row, 5).textContent).toBe("NULL");
  expect(cell(row, 5).dataset["staged"]).toBe("true");
  // A NOT NULL column offers no NULL.
  fireEvent.mouseDown(cell(row, 1), { button: 0 });
  fireEvent.keyDown(grid(), { key: "Enter" });
  expect(screen.queryByTestId("data-cell-editor-null")).toBeNull();
});

test("⌘S commits every staged cell through data.edits.commit, keyed by the primary key", async () => {
  const { api, sent } = recording();
  const commands = mount(api);

  await loaded();
  expect(commands.enabled("data.commitEdits")).toBe(false);
  editCell(0, 1, "INV-9999");
  editCell(2, 3, "written-off");
  expect(commands.enabled("data.commitEdits")).toBe(true);

  await act(async () => void commands.run("data.commitEdits"));

  expect(sent).toEqual([
    {
      source: "app",
      table: INVOICES,
      primaryKey: ["id"],
      edits: [
        { key: [FIXTURE_INVOICES[0]?.[0] ?? null], column: "number", value: "INV-9999" },
        { key: [FIXTURE_INVOICES[2]?.[0] ?? null], column: "status", value: "written-off" },
      ],
    },
  ]);
  await waitFor(() => expect(footer()).toContain("Committed 2 changes · 2 rows"));
  expect(cell(0, 1).textContent).toBe("INV-9999");
  expect(cell(0, 1).dataset["staged"]).toBeUndefined();
});

test("a failed commit shows its E-DATA code and fix and keeps the edits staged", async () => {
  mount(
    fixtureDataApi({
      commitError: { code: "E-DATA-SQL", message: "value too long", fix: "Shorten the value." },
    })
  );
  await loaded();
  editCell(0, 1, "INV-9999");
  await act(async () => void fireEvent.click(screen.getByTestId("data-commit")));

  const error = await screen.findByTestId("data-commit-error");

  expect(error.textContent).toContain("E-DATA-SQL");
  expect(error.textContent).toContain("Shorten the value.");
  expect(footer()).toContain("1 change staged · 1 row");
});

const ledger = FIXTURE_SOURCES.find((s) => s.name === "ledger");

test("a bulk commit to a remote source confirms on a card in its label's colour; one row doesn't", async () => {
  const { api, sent } = recording();

  mount(api, tabOn("ledger"));
  await loaded();
  editCell(0, 1, "INV-9999");
  await act(async () => void fireEvent.click(screen.getByTestId("data-commit")));
  expect(sent).toHaveLength(1);
  expect(screen.queryByTestId("data-confirm-commit")).toBeNull();

  editCell(1, 1, "INV-9998");
  editCell(2, 3, "written-off");
  fireEvent.click(screen.getByTestId("data-commit"));

  const card = await screen.findByTestId("data-confirm-commit");

  expect(sent).toHaveLength(1);
  expect(card.textContent).toContain("Commit 2 changes to 2 rows?");
  expect(card.textContent).toContain(`${ledger?.label.text} · LEDGER`);
  const id = cellOf(FIXTURE_INVOICES[1]?.[0]).raw ?? "";

  expect(screen.getAllByTestId("data-confirm-line")[0]?.textContent).toBe(
    `update invoices set number = 'INV-9998'where id = '${id.slice(0, 4)}…${id.slice(-3)}';-- 1 row`
  );
  expect(screen.getByTestId("data-confirm-bar").dataset["colour"]).toBe("tan");
  // Its label is too long for the button, so the button names the source.
  expect(screen.getByTestId("data-confirm-commit-button").textContent).toBe("Commit to ledger");

  await act(async () => void fireEvent.click(screen.getByTestId("data-confirm-commit-button")));
  expect(sent).toHaveLength(2);
  expect(sent[1]?.edits).toHaveLength(2);
});

test("a table without a primary key is read-only, and ↵ says why", async () => {
  const detail = new TableDetail({
    schema: "public",
    name: "audit",
    columns: [{ name: "note", type: "text", nullable: true, default: null, pk: false, fk: null }],
    indexes: [],
    constraints: [],
    rowEstimate: 2,
  });

  mount(
    recording(fixtureDataApi({ tables: { audit: { detail, rows: [["a"], ["b"]] } } })).api,
    tabOn("app", "audit")
  );
  await waitFor(() => expect(footer()).toContain("2 rows"));
  expect(screen.getByTestId("data-read-only").textContent).toBe(`Read-only · ${NO_KEY}`);

  fireEvent.mouseDown(cell(0, 0), { button: 0 });
  fireEvent.keyDown(grid(), { key: "Enter" });
  expect(screen.queryByTestId("data-cell-editor")).toBeNull();
  expect(screen.getByTestId("data-cell-inspector-note").textContent).toBe(
    `Not editable · ${NO_KEY}`
  );
});

test("a remote source with writes off is read-only and opens its connection card to allow them", async () => {
  if (ledger === undefined) throw new Error("no ledger fixture");
  const off = new DataSource({ ...Schema.encodeSync(DataSource)(ledger), writes: "off" });
  const sources = FIXTURE_SOURCES.map((s) => (s.name === "ledger" ? off : s));

  mount(recording(fixtureDataApi({ sources })).api, tabOn("ledger"), "bar");
  await loaded();
  expect(screen.getByTestId("data-read-only").textContent).toContain(
    "Writes are off for this remote data source"
  );

  fireEvent.click(screen.getByTestId("data-open-connection"));
  const writes = await screen.findByTestId("data-writes");

  const allowed = [...writes.querySelectorAll("button")].find((b) => b.textContent === "Allowed");

  if (allowed === undefined) throw new Error("no Allowed choice");
  fireEvent.click(allowed);
  await waitFor(() => expect(screen.queryByTestId("data-read-only")).toBeNull());
});

test("staged edits survive leaving the tab and belong to their agent session", async () => {
  mount(recording().api);
  await loaded();
  editCell(0, 1, "INV-9999");
  cleanup();

  mount(recording().api);
  await loaded();
  expect(footer()).toContain("1 change staged · 1 row");
  expect(cell(0, 1).dataset["staged"]).toBe("true");
});

test("closing a tab with staged edits asks first; Discard and close drops them with the tab", async () => {
  act(() => openTable("app", INVOICES, at));
  mount(recording().api, tabOn("app"), "strip");
  await loaded();
  editCell(0, 1, "INV-9999");

  fireEvent.click(screen.getByLabelText("Close invoices"));
  const dialog = await screen.findByTestId("data-close-staged");

  expect(dialog.textContent).toContain("Discard staged changes to invoices?");
  expect(screen.getAllByTestId("data-tab")).toHaveLength(1);

  fireEvent.click(screen.getByTestId("data-close-discard"));
  await waitFor(() => expect(screen.queryAllByTestId("data-tab")).toHaveLength(0));
  expect(Object.keys(editsStore.getState().tabs)).toEqual([]);
});
