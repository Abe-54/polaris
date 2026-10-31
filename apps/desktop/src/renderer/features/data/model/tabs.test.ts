import { describe, expect, test } from "bun:test";
import { closeTab, type DataTabs, emptyTabs, focusTab, openSqlTab, openTable } from "./tabs.ts";

const ids = (state: DataTabs) => state.tabs.map((t) => t.id);

const t = (name: string, schema = "public") => ({ schema, name });

describe("Data tabs", () => {
  test("opening a table that is already open focuses its tab instead of adding one", () => {
    let state = openTable(emptyTabs, "app", t("invoices"));

    state = openTable(state, "app", t("customers"));
    state = openTable(state, "app", t("invoices"));

    expect(state.tabs).toHaveLength(2);
    expect(state.active).toBe(state.tabs[0]?.id ?? "");
    // The same table on another Data Source, or in another schema, is its own tab.
    expect(openTable(state, "ledger", t("invoices")).tabs).toHaveLength(3);
    expect(openTable(state, "app", t("invoices", "billing")).tabs).toHaveLength(3);
  });

  test("a new tab opens right after the active one", () => {
    let state = openTable(emptyTabs, "app", t("invoices"));

    state = openTable(state, "app", t("customers"));
    state = focusTab(state, state.tabs[0]?.id ?? "");
    state = openSqlTab(state, "select 1", "app");

    expect(state.tabs.map((t) => (t.kind === "table" ? t.table : t.title))).toEqual([
      "invoices",
      "Query 1",
      "customers",
    ]);
  });

  test("SQL tabs are numbered per session and a closed number is never reused", () => {
    let state = openSqlTab(emptyTabs, "select 1", "app");

    state = openSqlTab(state, "select 2", "app");
    state = closeTab(state, state.active ?? "");
    state = openSqlTab(state, "select 3", "app");

    expect(state.tabs.map((t) => (t.kind === "sql" ? [t.title, t.sql] : []))).toEqual([
      ["Query 1", "select 1"],
      ["Query 3", "select 3"],
    ]);
  });

  test("closing the active tab focuses its right neighbour, else its left, else none", () => {
    let state = openTable(emptyTabs, "app", t("a"));

    state = openTable(state, "app", t("b"));
    state = openTable(state, "app", t("c"));
    const [a, b, c] = ids(state);

    state = closeTab(focusTab(state, b ?? ""), b ?? "");
    expect(state.active).toBe(c ?? "");
    state = closeTab(state, c ?? "");
    expect(state.active).toBe(a ?? "");
    state = closeTab(state, a ?? "");
    expect(state.active).toBeNull();
  });

  test("closing a background tab keeps the focus where it is", () => {
    let state = openTable(emptyTabs, "app", t("a"));

    state = openTable(state, "app", t("b"));
    const [a, b] = ids(state);

    expect(closeTab(state, a ?? "").active).toBe(b ?? "");
  });
});
