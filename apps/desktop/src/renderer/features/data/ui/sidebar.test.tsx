import { QueryLogEntry } from "@polaris/protocol";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { openTable } from "../model/store.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { FIXTURE_QUERY_LOG } from "../preview/fixtures.ts";
import { DATA_AT } from "../preview/scene.ts";
import {
  click,
  delivered,
  focusedData,
  found,
  mountData,
  page,
  shownTabs,
  useDataLayout,
} from "./data.testing.tsx";

useDataLayout();

const tableRow = (table: string) =>
  page()
    .queryAllByTestId("data-table-row")
    .find((r) => r.dataset.table === table);

describe("Sources", () => {
  test("a table opens its Table tab, and the connection bar names it", async () => {
    mountData(fixtureDataApi());
    const row = await waitFor(() => page().getByText("invoices", { selector: "span" }));

    click(row);

    expect(
      shownTabs.current?.tabs.map((t) =>
        t.kind === "table" ? `${t.sourceId}.${t.table}` : t.title
      )
    ).toEqual(["app.invoices"]);
    expect(page().getByTestId("data-connection-where").textContent).toBe(
      "PostgreSQL 16.4 : localhost:5432 : ledger_overdue : invoices"
    );
  });

  test("the table agents added this Turn shows its git letter in place of the estimate", async () => {
    const api = fixtureDataApi();
    const changes = delivered(api.watchTableChanges);

    mountData({ ...api, watchTableChanges: changes.watch });
    // waitFor leaves act while it waits, so the snapshots that mount the tree can land.
    await waitFor(() => changes.first);

    await waitFor(() => expect(tableRow("currencies")?.textContent).toBe("currenciesA"));
  });

  test("with no data sources it says what was searched and offers Add data source", async () => {
    mountData(fixtureDataApi({ sources: [] }));

    const empty = await waitFor(() => page().getByTestId("data-no-sources"));

    expect(empty.textContent).toContain("No data sources found");
    expect(within(empty).getByRole("button", { name: "Add data source" })).toBeTruthy();
    expect(page().queryByTestId("data-connection-bar")).toBeNull();
  });

  test("while the Host is Offline the tree stays, dimmed, and adding a source waits", async () => {
    mountData(fixtureDataApi(), { state: "offline" });
    const add = await waitFor(() => page().getByTestId("data-add-source"));

    expect(add.hasAttribute("disabled")).toBe(true);
    expect(page().getByTestId("data-sidebar-body").className).toContain(
      "opacity-(--opacity-dimmed)"
    );
    expect(page().getByTestId("data-where").textContent).toContain("Offline");
  });

  test("names read in their own direction, so an Arabic name truncates from its end", async () => {
    mountData(fixtureDataApi());
    act(() => openTable("app", "invoices", DATA_AT));
    const table = await waitFor(() => found(tableRow("invoices"), "invoices row"));

    expect(within(table).getByText("invoices").getAttribute("dir")).toBe("auto");
    expect(
      page()
        .getByText("app", { selector: "[data-testid='data-source-row'] span" })
        .getAttribute("dir")
    ).toBe("auto");
  });
});

describe("the Sources tree's keyboard", () => {
  const focused = () => focusedData().treeKey ?? null;

  const key = (key: string) =>
    act(() => {
      fireEvent.keyDown(found(document.activeElement, "focused row"), { key });
    });

  test("the tree is one tab stop, and ↓ moves into the source's schema", async () => {
    mountData(fixtureDataApi());
    await waitFor(() => expect(tableRow("invoices")).toBeDefined());
    const tree = page().getByRole("tree");

    const stops = [...tree.querySelectorAll<HTMLElement>("[data-tree-key]")].filter(
      (el) => el.tabIndex === 0
    );

    expect(stops.map((el) => el.dataset.source)).toEqual(["app"]);
    act(() => stops[0]?.focus());
    key("ArrowDown");

    expect(focused()).toBe("schema\u0000app\u0000public");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("0");
    key("ArrowDown");
    expect(focusedData().table).toBe("customers");
  });

  test("← goes to the parent, then closes it; → opens it again", async () => {
    mountData(fixtureDataApi());
    const row = await waitFor(() => found(tableRow("invoices"), "invoices row"));
    const source = () => found(page().getAllByTestId("data-source-row")[0], "app row");

    act(() => row.focus());
    key("ArrowLeft");
    expect(focused()).toBe("schema\u0000app\u0000public");
    key("ArrowLeft");
    expect(tableRow("invoices")).toBeUndefined();
    key("ArrowLeft");
    expect(focused()).toBe("source\u0000app");
    key("ArrowLeft");
    expect(source().getAttribute("aria-expanded")).toBe("false");
    key("ArrowRight");
    expect(source().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Query log", () => {
  const openLog = async () => {
    click(await waitFor(() => page().getByRole("radio", { name: /Query log/ })));

    return waitFor(() => page().getAllByTestId("data-log-row"));
  };

  test("a row re-runs into a new SQL tab on its source", async () => {
    mountData(fixtureDataApi());
    const rows = await openLog();

    expect(rows[0]?.dataset.state).toBe("needs-you");
    expect(rows[0]?.textContent).toContain("Backfill currency · appneeds you");
    click(
      found(
        rows.find((r) => r.textContent?.includes("You · app")),
        "row of yours"
      )
    );

    expect(
      shownTabs.current?.tabs.map((t) => (t.kind === "sql" ? [t.title, t.sourceId, t.sql] : null))
    ).toEqual([["Query 1", "app", "select * from invoices where currency is null"]]);
  });

  test("a re-run keeps the params the query ran with", async () => {
    const yours = found(
      FIXTURE_QUERY_LOG.find((e) => e.id === "q-user-2"),
      "q-user-2"
    );

    const parametrised = Schema.decodeSync(QueryLogEntry)({
      ...Schema.encodeSync(QueryLogEntry)(yours),
      id: "q-params",
      sql: "select * from invoices where customer_id = $1 and status = $2",
      params: ["c-42", "overdue"],
    });

    mountData(fixtureDataApi({ queryLog: [parametrised] }));
    click(found((await openLog())[0], "the parametrised row"));

    expect(shownTabs.current?.tabs.map((t) => (t.kind === "sql" ? t.params : null))).toEqual([
      ["c-42", "overdue"],
    ]);
  });

  test("a query run outside Polaris keeps its data source in the byline", async () => {
    mountData(fixtureDataApi());
    const rows = await openLog();

    const outside = found(
      rows.find((r) => r.textContent?.includes("outside Polaris")),
      "outside row"
    );

    expect(within(outside).getByTestId("data-log-byline").textContent).toBe(
      "Backfill currency · app · outside Polaris"
    );
  });
});

describe("Agents in this worktree", () => {
  test("each agent says what it is doing to data", async () => {
    mountData(fixtureDataApi());

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
