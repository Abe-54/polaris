import "../../../test/dom.testing.ts";
import { Toaster, TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MAX_DRAFT_LENGTH, type SelfSpan } from "@polaris/protocol";
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
import type { DataApi } from "../data/api.ts";
import { type DataTab, tableTabId } from "../model/tabs.ts";
import { treeRows } from "../model/tree.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import {
  FIXTURE_INVOICES,
  FIXTURE_SCHEMA,
  FIXTURE_SESSIONS,
  FIXTURE_SOURCES,
} from "../preview/fixtures.ts";
import type { PolarisApi } from "../../../../shared/api.ts";
import { connectSelfTraces } from "../../selfTraces/index.ts";
import { tableViews } from "./table/state.ts";
import { NO_DETAIL, TABLE_LOAD_SPAN } from "./table/useLoadTrace.ts";
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
    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, key);
    else Object.defineProperty(HTMLElement.prototype, key, descriptor);
});

afterEach(() => {
  cleanup();
  tableViews.setState({}, true);
  dataTabsStore.setState({ sessions: {}, shown: null });
});

const at = { hostKey: "local", sessionId: FIXTURE_SESSIONS.overdue.id };

const INVOICES = { schema: "public", name: "invoices" };

const tab: Extract<DataTab, { kind: "table" }> = {
  kind: "table",
  id: tableTabId("app", INVOICES),
  sourceId: "app",
  table: "invoices",
  ref: INVOICES,
};

afterEach(() => updateDraft(at.hostKey, at.sessionId, () => ""));

const mount = (api: DataApi = fixtureDataApi(), shown = tab) => {
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
        <DataLayer api={api}>
          <TableTabBody at={at} tab={shown} />
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

const CUSTOMERS = { schema: "public", name: "customers" };

const viewKey = (id: string) => `local\u0000${at.sessionId}\u0000${id}`;

const followFirstKey = async () => {
  await waitFor(() => expect(screen.getAllByTestId("data-fk").length).toBeGreaterThan(0));
  const link = screen.getAllByTestId("data-fk")[0];

  if (link === undefined) throw new Error("no foreign key rendered");
  act(() => openTable("app", INVOICES, at));
  fireEvent.click(link);
};

test("a foreign key opens the sidebar's tab for its table, filtered to the row it points at", async () => {
  mount();
  await followFirstKey();
  const customer = cellOf(FIXTURE_INVOICES[0]?.[2]).raw;

  const fromSidebar = treeRows({
    sources: FIXTURE_SOURCES,
    trees: new Map([["app", { status: "ready", value: FIXTURE_SCHEMA }]]),
    changes: [],
    toggled: new Map(),
  }).find((row) => row.kind === "table" && row.source === "app" && row.table === "customers");

  if (fromSidebar?.kind !== "table") throw new Error("the sidebar has no customers row");
  expect(dataTabsStore.getState().sessions[`local\u0000${at.sessionId}`]?.active).toBe(
    tableTabId(fromSidebar.source, fromSidebar.ref)
  );
  expect(tableViews.getState()[viewKey(tableTabId("app", CUSTOMERS))]?.filter).toBe(
    `id = '${customer}'`
  );
});

test("following a key into a filtered tab keeps that filter one Back away", async () => {
  const target = tableTabId("app", CUSTOMERS);

  tableViews.setState({ [viewKey(target)]: { filter: "name like 'A%'", view: "data", back: [] } });
  mount();
  await followFirstKey();
  expect(tableViews.getState()[viewKey(target)]?.back).toEqual(["name like 'A%'"]);

  cleanup();
  mount(fixtureDataApi(), {
    kind: "table",
    id: target,
    sourceId: "app",
    table: "customers",
    ref: CUSTOMERS,
  });
  fireEvent.click(await waitFor(() => screen.getByTestId("data-filter-back")));
  expect(tableViews.getState()[viewKey(target)]).toMatchObject({
    filter: "name like 'A%'",
    back: [],
  });
});

/** A fixture api that records each page's SQL. */
const recording = () => {
  const api = fixtureDataApi();
  const sent: Array<string> = [];

  return {
    sent,
    api: {
      ...api,
      queryStream: (where, input, on) => {
        sent.push(input.sql);

        return api.queryStream?.(where, input, on) ?? (() => undefined);
      },
    } satisfies DataApi,
  };
};

test("a table in another schema is read by its schema and name, each quoted", async () => {
  const { api, sent } = recording();
  const billing = { schema: "billing", name: "invoices" };

  mount(api, { ...tab, id: tableTabId("app", billing), table: "billing.invoices", ref: billing });
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(sent[0]).toStartWith('SELECT * FROM "billing"."invoices"\n');
});

test("a filter that would reach past its parentheses is refused before it runs", async () => {
  const { api, sent } = recording();

  tableViews.setState({
    [viewKey(tab.id)]: { filter: "status = 'paid' /* only paid", view: "data", back: [] },
  });
  mount(api);
  await waitFor(() =>
    expect(screen.getByTestId("data-table-failed").textContent).toContain("isn't closed")
  );
  expect(sent).toEqual([]);
});

test("⌘L adds the selected rows to the agent session's draft as CSV", async () => {
  const commands = mount();

  await waitFor(() => expect(footer()).toContain(`${FIXTURE_INVOICES.length} rows`));
  expect(commands.enabled("data.addRowsToSession")).toBe(false);

  const first = document.querySelector('[data-row="0"] [data-col="1"]');

  if (first === null) throw new Error("the first row didn't render");
  fireEvent.mouseDown(first, { button: 0 });
  expect(commands.enabled("data.addRowsToSession")).toBe(true);
  act(() => void commands.run("data.addRowsToSession"));

  const [id, number] = FIXTURE_INVOICES[0] ?? [];

  expect(draft()).toStartWith("1 row from `app` · `invoices`:\n```csv\nid,number,");
  expect(draft()).toContain(`\n${cellOf(id).raw},${cellOf(number).raw},`);
});

test("past the draft's limit, ⌘L offers the first rows that fit and the draft stays within it", async () => {
  const commands = mount();

  updateDraft(at.hostKey, at.sessionId, () => "x".repeat(MAX_DRAFT_LENGTH - 2_000));
  await waitFor(() => expect(footer()).toContain(`${FIXTURE_INVOICES.length} rows`));
  fireEvent.keyDown(screen.getByTestId("data-grid"), { key: "a", metaKey: true });

  const button = await waitFor(() => screen.getByTestId("data-add-rows"));

  expect(button.textContent).toMatch(/^Add the first \d+ rows of 500 to agent session/);
  act(() => void commands.run("data.addRowsToSession"));
  expect(draft().length).toBeLessThanOrEqual(MAX_DRAFT_LENGTH);
  expect(draft()).toContain("The first ");
});

/** Self-Traces switched on against a fake main; `spans()` flushes and returns the loads' Spans. */
const tracing = async () => {
  const batches: Array<ReadonlyArray<SelfSpan>> = [];

  const api: PolarisApi = {
    // SAFETY: Self-Traces request only `selfTraces.state`, answered here.
    request: (async () => ({
      ok: true,
      value: { enabled: true, version: "1" },
    })) as PolarisApi["request"],
    selfSpans: (spans) => void batches.push(spans),
    onAppEvent: () => () => undefined,
    subscribe: () => () => undefined,
  };

  const traces = connectSelfTraces(api);

  await waitFor(() => expect(traces.enabled()).toBe(true));

  return {
    off: () => traces.setEnabled(false),
    spans: () => {
      traces.flush();

      return batches.flat().filter((span) => span.name === TABLE_LOAD_SPAN);
    },
  };
};

test("a table's load is one Span from its describe to the first page, naming the table", async () => {
  const traces = await tracing();

  mount();
  await waitFor(() => expect(traces.spans().length).toBe(1));
  const spans = traces.spans();
  traces.off();

  expect(spans.map((span) => [span.status, span.attributes])).toEqual([
    [
      "unset",
      {
        "polaris.data.source": "app",
        "polaris.data.table": "public.invoices",
        "polaris.data.engine": "postgres",
        "polaris.data.outcome": "rows",
        "polaris.data.rows": FIXTURE_INVOICES.length,
      },
    ],
  ]);
});

test("the describe and a data.query first page carry the load's Span, so the Daemon's join its Trace", async () => {
  const traces = await tracing();
  const { queryStream: _, ...api } = fixtureDataApi();
  const sent: Array<string | undefined> = [];

  mount({
    ...api,
    describe: (at, input, options) => {
      sent.push(options?.trace?.traceparent);

      return api.describe(at, input);
    },
    query: (at, input, options) => {
      sent.push(options?.trace?.traceparent);

      return api.query(at, input);
    },
  });
  await waitFor(() => expect(traces.spans().length).toBe(1));
  const [span] = traces.spans();
  traces.off();

  expect(sent).toEqual([
    `00-${span?.traceId}-${span?.id}-01`,
    `00-${span?.traceId}-${span?.id}-01`,
  ]);
});

const noDetail = async () => ({ ok: true as const, value: FIXTURE_SCHEMA });

const describeFailed = async () => ({
  ok: false as const,
  error: { code: "E-DATA-DENIED", message: "Not allowed" },
});

test.each([
  ["answers without the table's detail", noDetail, "no-detail", NO_DETAIL],
  ["fails", describeFailed, "describe-failed", "Not allowed"],
])(
  "when the describe %s, the load's Span fails without asking for rows",
  async (_, describe, outcome, failure) => {
    const traces = await tracing();
    const api = fixtureDataApi();
    let reads = 0;

    mount({
      ...api,
      describe,
      query: (...args) => {
        reads++;

        return api.query(...args);
      },
      queryStream: (...args) => {
        reads++;

        return api.queryStream?.(...args) ?? (() => undefined);
      },
    });
    await waitFor(() => expect(traces.spans().length).toBe(1));
    const [span] = traces.spans();
    traces.off();

    expect(reads).toBe(0);
    expect([span?.status, span?.statusMessage, span?.attributes["polaris.data.outcome"]]).toEqual([
      "error",
      failure,
      outcome,
    ]);
  }
);
