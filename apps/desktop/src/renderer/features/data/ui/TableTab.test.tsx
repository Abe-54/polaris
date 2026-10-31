import "../../../test/dom.testing.ts";
import { Toaster, TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { updateDraft } from "../../session/state.ts";
import { DataLayer } from "../data/hooks.tsx";
import { cellOf } from "../grid/value.ts";
import { dataTabsStore, openTable } from "../model/store.ts";
import { tableTabId } from "../model/tabs.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { FIXTURE_INVOICES, FIXTURE_SESSIONS } from "../preview/fixtures.ts";
import { tableViews } from "./table/state.ts";
import { TableTabBody } from "./TableTab.tsx";

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
});

const at = { hostKey: "local", sessionId: FIXTURE_SESSIONS.overdue.id };

const tab = {
  kind: "table",
  id: tableTabId("app", "invoices"),
  sourceId: "app",
  table: "invoices",
} as const;

const mount = () => {
  const store = createStore<AppState>(() => ({ ...initialState, density: "calm" }));
  const commands = createCommandRegistry({ platform: "mac" });

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
        <DataLayer api={fixtureDataApi()}>
          <TableTabBody at={at} tab={tab} />
        </DataLayer>
        <Toaster />
      </TooltipProvider>
    </AppProvider>
  );

  return commands;
};

const footer = () => screen.getByTestId("data-table-footer").textContent ?? "";

const draft = () => {
  let text = "";

  updateDraft(at.hostKey, at.sessionId, (d) => {
    text = d;

    return d;
  });

  return text;
};

test("the table's rows load with typed headers, and the filter narrows them", async () => {
  mount();
  await waitFor(() => expect(footer()).toContain(`${FIXTURE_INVOICES.length} rows`));
  expect(screen.getByText("uuid → customers")).not.toBeNull();

  const overdue = FIXTURE_INVOICES.filter((row) => row[3] === "overdue").length;
  const filter = screen.getByLabelText("Filter rows");

  fireEvent.change(filter, { target: { value: "status = 'overdue'" } });
  fireEvent.keyDown(filter, { key: "Enter" });
  await waitFor(() => expect(footer()).toContain(`${overdue} rows`));
});

test("a foreign key opens its table filtered to the row it points at", async () => {
  mount();
  await waitFor(() => expect(screen.getAllByTestId("data-fk").length).toBeGreaterThan(0));
  const customer = cellOf(FIXTURE_INVOICES[0]?.[2]).raw;

  const link = screen.getAllByTestId("data-fk")[0];

  if (link === undefined) throw new Error("no foreign key rendered");
  openTable("app", "invoices", at);
  fireEvent.click(link);

  const key = `local\u0000${at.sessionId}\u0000${tableTabId("app", "customers")}`;

  expect(dataTabsStore.getState().sessions[`local\u0000${at.sessionId}`]?.active).toBe(
    tableTabId("app", "customers")
  );
  expect(tableViews.getState()[key]?.filter).toBe(`"id" = '${customer}'`);
});

test("⌘L adds the selected rows to the agent session's draft as CSV", async () => {
  const commands = mount();

  await waitFor(() => expect(footer()).toContain(`${FIXTURE_INVOICES.length} rows`));
  expect(commands.enabled("data.addRowsToSession")).toBe(false);

  const first = document.querySelector('[data-row="0"][data-col="1"]');

  if (first === null) throw new Error("the first row didn't render");
  fireEvent.mouseDown(first, { button: 0 });
  expect(commands.enabled("data.addRowsToSession")).toBe(true);
  act(() => void commands.run("data.addRowsToSession"));

  const [id, number] = FIXTURE_INVOICES[0] ?? [];

  expect(draft()).toStartWith("1 row from `app` · `invoices`:\n```csv\nid,number,");
  expect(draft()).toContain(`\n${cellOf(id).raw},${cellOf(number).raw},`);
});
