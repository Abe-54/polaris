import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { dataTabsStore, openSqlTab, openTable, useDataTabs } from "../model/store.ts";
import { DATA_AT } from "../preview/scene.ts";
import { TabStrip } from "./TabStrip.tsx";

afterEach(() => {
  cleanup();
  dataTabsStore.setState({ sessions: {}, shown: null });
});

const Strip = () => <TabStrip at={DATA_AT} state={useDataTabs(DATA_AT)} />;

const selected = () =>
  screen
    .getAllByTestId("data-tab")
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.textContent);

const press = (key: string) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });

test("← and → move to the next tab and select it, wrapping; Home and End jump", () => {
  act(() => {
    openTable("app", { schema: "public", name: "invoices" }, DATA_AT);
    openTable("app", { schema: "public", name: "customers" }, DATA_AT);
    openSqlTab("select 1", "app", DATA_AT);
  });
  render(<Strip />);
  act(() => screen.getAllByTestId("data-tab")[2]?.focus());

  press("ArrowRight");
  expect([selected(), document.activeElement?.textContent]).toEqual([["invoices"], "invoices"]);
  press("ArrowLeft");
  expect(selected()).toEqual(["Query 1"]);
  press("Home");
  press("ArrowRight");
  expect(selected()).toEqual(["customers"]);
  press("End");
  expect([selected(), document.activeElement?.getAttribute("tabindex")]).toEqual([
    ["Query 1"],
    "0",
  ]);
});

test("a tab title reads in its own direction", () => {
  act(() => openTable("app", { schema: "public", name: "الفواتير" }, DATA_AT));
  render(<Strip />);

  expect(screen.getByText("الفواتير").getAttribute("dir")).toBe("auto");
});
