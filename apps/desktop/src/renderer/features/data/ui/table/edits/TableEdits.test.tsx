import { DataSource, TableDetail } from "@polaris/protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { NO_KEY } from "../../../grid/editors.ts";
import { cellOf, displayOf } from "../../../grid/value.ts";
import { openTable } from "../../../model/store.ts";
import { fixtureDataApi } from "../../../preview/fixtureApi.ts";
import { FIXTURE_INVOICES, FIXTURE_SOURCES } from "../../../preview/fixtures.ts";
import {
  cell,
  editCell,
  footer,
  grid,
  installGridHarness,
  at,
  INVOICES,
  ledger,
  loaded,
  mount,
  recording,
  tabOn,
} from "./edits.testing.tsx";
import { editsStore } from "./store.ts";

installGridHarness();

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
        {
          key: [FIXTURE_INVOICES[0]?.[0] ?? null],
          column: "number",
          before: FIXTURE_INVOICES[0]?.[1] ?? null,
          value: "INV-9999",
        },
        {
          key: [FIXTURE_INVOICES[2]?.[0] ?? null],
          column: "status",
          before: FIXTURE_INVOICES[2]?.[3] ?? null,
          value: "written-off",
        },
      ],
    },
  ]);
  await waitFor(() => expect(footer()).toContain("Committed 2 changes · 2 rows"));
  expect(cell(0, 1).textContent).toBe("INV-9999");
  expect(cell(0, 1).dataset["staged"]).toBeUndefined();
});

test("a failed commit names the row in the user's words, never the agent's fix, and keeps the edits", async () => {
  const id = FIXTURE_INVOICES[0]?.[0] ?? null;

  mount(
    fixtureDataApi({
      commitError: {
        code: "E-DATA-SQL",
        message: "value too long for type character varying(8)",
        fix: "Check the statement and parameter types.",
        row: [id],
      },
    })
  );
  await loaded();
  editCell(0, 1, "INV-9999");
  await act(async () => void fireEvent.click(screen.getByTestId("data-commit")));

  const error = await screen.findByTestId("data-commit-error");

  expect(error.textContent).toBe(
    `E-DATA-SQL · Commit failed · The database refused the change on id = ${displayOf(cellOf(id))}: value too long for type character varying(8)` +
      "Correct the value or drop the edit, then commit again. Your edits are still staged."
  );
  expect(footer()).toContain("1 change staged · 1 row");
});

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
