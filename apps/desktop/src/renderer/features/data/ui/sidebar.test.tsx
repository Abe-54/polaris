import "../../../test/dom.testing.ts";
import { type ConnectionState, DataSource } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import type { DataApi } from "../data/api.ts";
import { DataLayer } from "../data/hooks.tsx";
import { dataTabsStore, openTable, useDataTabs } from "../model/store.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { DATA_AT, DATA_WORKSPACE_ID, dataHost, dataHostModel } from "../preview/scene.ts";
import { ConnectionBar } from "./ConnectionBar.tsx";
import { DataSidebar } from "./Sidebar.tsx";

const KEYS = ["offsetWidth", "offsetHeight"] as const;

const saved = KEYS.map(
  (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const
);

/** happy-dom has no layout: lists get a tall viewport, and each virtualized row a tree row's height. */
function size(this: HTMLElement, key: (typeof KEYS)[number]) {
  if (key === "offsetWidth") return 270;

  return this.hasAttribute("data-index") ? 28 : 2000;
}

beforeAll(() => {
  for (const key of KEYS)
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return size.call(this, key);
      },
    });
});

afterAll(() => {
  for (const [key, descriptor] of saved)
    if (descriptor !== undefined) Object.defineProperty(HTMLElement.prototype, key, descriptor);
});

afterEach(() => {
  cleanup();
  dataTabsStore.setState({ sessions: {}, shown: null });
});

const page = () => within(document.body);

/** The tabs of the shown session, as plain lines, read through the real store. */
let tabs: ReturnType<typeof useDataTabs> | null = null;

const TabsProbe = () => {
  tabs = useDataTabs(DATA_AT);

  return null;
};

/** The sidebar and connection bar on the fixtures, as Data mode lays them out. */
const mount = (api: DataApi, state: ConnectionState = "connected") => {
  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [dataHost(state)],
    hostModels: { [DATA_AT.hostKey]: dataHostModel() },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  const Layout = () => {
    const shown = useDataTabs(DATA_AT);
    const active = shown.tabs.find((t) => t.id === shown.active) ?? null;
    const props = { at: DATA_AT, hostKey: DATA_AT.hostKey, workspaceId: DATA_WORKSPACE_ID, active };

    return (
      <>
        <DataSidebar {...props} />
        <ConnectionBar {...props} />
        <TabsProbe />
      </>
    );
  };

  render(
    <AppProvider value={{ connection, navigation, commands }}>
      <TooltipProvider>
        <DataLayer api={api}>
          <Layout />
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );
};

/** The element a query found, or a failure naming what was missing. */
const found = <E extends Element>(el: E | null | undefined, what: string): E => {
  if (el === null || el === undefined) throw new Error(`No ${what}`);

  return el;
};

const click = (el: Element) =>
  act(() => {
    fireEvent.click(el);
  });

describe("Sources", () => {
  test("a table opens its Table tab, and the connection bar names it", async () => {
    mount(fixtureDataApi());
    const row = await waitFor(() => page().getByText("invoices", { selector: "span" }));

    click(row);

    expect(
      tabs?.tabs.map((t) => (t.kind === "table" ? `${t.sourceId}.${t.table}` : t.title))
    ).toEqual(["app.invoices"]);
    expect(page().getByTestId("data-connection-bar").textContent).toBe(
      "LOCALPostgreSQL 16.4 : localhost:5432 : ledger_overdue : invoicesAgents read · writes ask you"
    );
  });

  test("the table agents added this Turn shows its git letter in place of the estimate", async () => {
    mount(fixtureDataApi());

    const row = await waitFor(() =>
      page()
        .getAllByTestId("data-table-row")
        .find((r) => r.dataset.table === "currencies")
    );

    expect(row?.textContent).toBe("currenciesA");
  });

  test("with no data sources it says what was searched and offers Add data source", async () => {
    mount(fixtureDataApi({ sources: [] }));

    const empty = await waitFor(() => page().getByTestId("data-no-sources"));

    expect(empty.textContent).toContain("No data sources found");
    expect(within(empty).getByRole("button", { name: "Add data source" })).toBeTruthy();
    expect(page().queryByTestId("data-connection-bar")).toBeNull();
  });

  test("Add data source posts the form, password included, and the new source joins the tree", async () => {
    const api = fixtureDataApi();
    const saved: Array<unknown> = [];

    mount({
      ...api,
      saveSource: (at, input) => {
        saved.push(input);

        return api.saveSource(at, input);
      },
    });
    click(await waitFor(() => page().getByTestId("data-add-source")));
    const form = page().getByTestId("data-source-form");

    const field = (name: string) =>
      within(form).getByText(name).parentElement?.querySelector("input");

    for (const [name, value] of [
      ["Name", "warehouse"],
      ["Host", "warehouse.internal"],
      ["Database", "dw"],
      ["User", "reader"],
      ["Password", "s3cret"],
    ] as const) {
      act(() => {
        fireEvent.change(found(field(name), name), { target: { value } });
      });
    }

    await act(async () => {
      fireEvent.submit(form);
    });

    expect(saved).toEqual([
      {
        name: "warehouse",
        engine: "postgres",
        host: "warehouse.internal",
        port: 5432,
        database: "dw",
        user: "reader",
        password: "s3cret",
        label: { text: "", colour: "red" },
      },
    ]);
    await waitFor(() =>
      expect(
        page()
          .getAllByTestId("data-source-row")
          .map((r) => r.dataset.source)
      ).toContain("warehouse")
    );
    expect(page().queryByTestId("data-source-form")).toBeNull();
  });

  test("while the Host is Offline the tree stays, dimmed, and adding a source waits", async () => {
    mount(fixtureDataApi(), "offline");
    const add = await waitFor(() => page().getByTestId("data-add-source"));

    expect(add.hasAttribute("disabled")).toBe(true);
    expect(page().getByTestId("data-sidebar-body").className).toContain(
      "opacity-(--opacity-dimmed)"
    );
    expect(page().getByTestId("data-where").textContent).toContain("Offline");
  });
});

describe("Query log", () => {
  test("a row re-runs into a new SQL tab on its source", async () => {
    mount(fixtureDataApi());
    click(await waitFor(() => page().getByRole("radio", { name: /Query log/ })));
    const rows = await waitFor(() => page().getAllByTestId("data-log-row"));

    expect(rows[0]?.dataset.state).toBe("needs-you");
    expect(rows[0]?.textContent).toContain("Backfill currency · appneeds you");
    click(
      found(
        rows.find((r) => r.textContent?.includes("You · app")),
        "row of yours"
      )
    );

    expect(tabs?.tabs.map((t) => (t.kind === "sql" ? [t.title, t.sourceId, t.sql] : null))).toEqual(
      [["Query 1", "app", "select * from invoices where currency is null"]]
    );
  });
});

describe("Agents in this worktree", () => {
  test("each agent says what it is doing to data", async () => {
    mount(fixtureDataApi());

    // Each row is title, description, then its age ("6h"), which moves with the clock.
    const described = () =>
      page()
        .getAllByTestId("data-agent")
        .map((r) => r.textContent?.replace(/(\d+[mhd]|now)$/, ""));

    await waitFor(() =>
      expect(described()).toEqual([
        "Backfill currencyWants to write",
        "Fix overdue totalsQuerying invoices",
      ])
    );
  });
});

describe("the connection bar", () => {
  test("a label colour from its card posts data.source.label and re-tints the bar", async () => {
    const api = fixtureDataApi();
    const posted: Array<unknown> = [];

    mount({
      ...api,
      labelSource: (at, source, label) => {
        posted.push([source, label]);

        return api.labelSource(at, source, label);
      },
    });
    act(() => openTable("ledger", "invoices", DATA_AT));
    const bar = await waitFor(() => page().getByTestId("data-connection-bar"));

    expect(bar.dataset.colour).toBe("tan");
    click(bar);
    await act(async () => {
      fireEvent.click(page().getByRole("radio", { name: "Blue" }));
    });

    expect(posted).toEqual([["ledger", { text: "PLANETSCALE · OVERDUE-TOTALS", colour: "blue" }]]);
    await waitFor(() =>
      expect(page().getByTestId("data-connection-bar").dataset.colour).toBe("blue")
    );
  });

  test("opening the card re-lists the checkout first, so it shows the source as it is now", async () => {
    const fields = Schema.encodeSync(DataSource);

    const down = FIXTURE_SOURCES.map((s) =>
      s.name === "app" ? new DataSource({ ...fields(s), reachable: false, error: "gone" }) : s
    );

    let relisted = false;

    mount(
      fixtureDataApi({
        relist: () => {
          relisted = true;

          return down;
        },
      })
    );
    const bar = await waitFor(() => page().getByTestId("data-connection-bar"));

    // Data's first showing re-lists too; only the card's own re-list matters here.
    await waitFor(() => expect(relisted).toBe(true));
    relisted = false;
    click(bar);

    await waitFor(() =>
      expect(page().getByTestId("data-connection-details").textContent).toContain(
        "can't reach it · gone"
      )
    );
    expect(relisted).toBe(true);
  });

  test("the label text posts on Enter, uppercased", async () => {
    const api = fixtureDataApi();
    const posted: Array<unknown> = [];

    mount({
      ...api,
      labelSource: (at, source, label) => {
        posted.push(label);

        return api.labelSource(at, source, label);
      },
    });
    click(await waitFor(() => page().getByTestId("data-connection-bar")));
    const field = page().getByTestId("data-label-field");

    act(() => {
      fireEvent.change(field, { target: { value: "dev box" } });
    });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });

    expect(posted).toEqual([{ text: "DEV BOX", colour: "none" }]);
    await waitFor(() =>
      expect(page().getByTestId("data-connection-kicker").textContent).toBe("DEV BOX")
    );
  });
});
