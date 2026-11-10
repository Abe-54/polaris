import "../../../test/dom.testing.ts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { TooltipProvider } from "@polaris/ui";
import { type ReactNode, useState } from "react";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import type { GridColumn } from "./columns.ts";
import { DataGrid } from "./DataGrid.tsx";
import { GridCell } from "./GridCell.tsx";
import { type DataValue, DataValueTags } from "./value.ts";
import { emptySelection, type GridSelection, selectedRows } from "./selection.ts";

const SIZES = { offsetWidth: 1200, offsetHeight: 800 } as const;

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

afterEach(cleanup);

const COLUMNS: ReadonlyArray<GridColumn> = [
  { name: "id", type: "int8" },
  { name: "customer_id", type: "uuid", fk: { schema: "public", table: "customers", column: "id" } },
  { name: "body", type: "jsonb" },
];

const ROWS = Array.from({ length: 10_000 }, (_, i) => [
  i + 1,
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  i === 0
    ? DataValueTags.cases.Json.make({
        text: `{"items":["${"a".repeat(500)}"],"amount":12345678901234567890,"p":1.10}`,
      })
    : null,
]);

let selection: GridSelection = emptySelection;

const Harness = ({ onForeignKey }: { onForeignKey: (value: DataValue | undefined) => void }) => {
  const [value, setValue] = useState(emptySelection);

  selection = value;

  return (
    <DataGrid
      label="invoices"
      columns={COLUMNS}
      rows={ROWS}
      selection={value}
      onSelectionChange={setValue}
      onForeignKey={(_column, v) => onForeignKey(v)}
    />
  );
};

const mount = (onForeignKey: (value: DataValue | undefined) => void = () => undefined) =>
  mountGrid(<Harness onForeignKey={onForeignKey} />);

const mountGrid = (grid: ReactNode) => {
  const store = createStore<AppState>(() => ({ ...initialState, density: "calm" }));

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
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>{grid}</TooltipProvider>
    </AppProvider>
  );
};

test("10,000 rows render only the rows in view, with typed headers", () => {
  mount();

  const rows = screen.getAllByTestId("data-grid-row");

  expect(rows.length).toBeGreaterThan(10);
  expect(rows.length).toBeLessThan(60);
  expect(screen.getByRole("grid").getAttribute("aria-rowcount")).toBe("10001");
  expect(screen.getByText("uuid → customers")).not.toBeNull();
});

const Arriving = () => {
  const [rows, setRows] = useState<ReadonlyArray<ReadonlyArray<DataValue>>>([]);

  return (
    <>
      <button type="button" onClick={() => setRows([[1, "x".repeat(40), "y".repeat(40)]])}>
        arrive
      </button>
      <DataGrid
        label="arriving"
        columns={COLUMNS}
        rows={rows}
        selection={emptySelection}
        onSelectionChange={() => undefined}
      />
    </>
  );
};

test("columns widened by the first rows keep the header as wide as its cells", () => {
  mountGrid(<Arriving />);

  fireEvent.click(screen.getByText("arrive"));

  const [header] = screen.getAllByRole("row");
  const [gutter, spacer] = Array.from(header?.children ?? []);
  const cells = screen.getAllByRole("columnheader");

  const sum = [gutter, spacer, ...cells].reduce(
    // SAFETY: the header's children are all elements with inline widths.
    (total, el) => total + parseFloat((el as HTMLElement | undefined)?.style.width ?? "0"),
    0
  );

  expect(parseFloat(header?.style.width ?? "")).toBe(sum);
});

test("a foreign key opens its value; a click selects the row and ⇧↓ extends it", () => {
  const opened: Array<DataValue | undefined> = [];

  mount((v) => opened.push(v));
  const fk = screen.getAllByTestId("data-fk")[2];
  const nullCell = screen.getAllByText("NULL")[0];

  if (fk === undefined || nullCell === undefined) throw new Error("rows didn't render");
  fireEvent.click(fk);
  expect(opened).toEqual(["00000000-0000-4000-8000-000000000002"]);

  fireEvent.mouseDown(nullCell, { button: 0 });
  fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown", shiftKey: true });
  expect(selectedRows(selection)).toEqual([1, 2]);
});

test("↵ on a clipped cell shows it whole, indented as stored, and esc closes it", () => {
  mount();
  const json = document.querySelector('[data-row="0"] [data-col="2"]');

  if (json === null) throw new Error("the first row didn't render");
  fireEvent.mouseDown(json, { button: 0 });
  fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter" });

  const inspector = screen.getByTestId("data-cell-inspector");

  expect(inspector.textContent).toContain(`"items": [\n    "${"a".repeat(500)}"`);
  expect(inspector.textContent).toContain('"amount": 12345678901234567890,\n  "p": 1.10');
  expect(inspector.textContent).toContain("553 characters");
  fireEvent.keyDown(inspector, { key: "Escape" });
  expect(screen.queryByTestId("data-cell-inspector")).toBeNull();
});

const cellFor = (value: DataValue, column: Partial<GridColumn> = {}) => {
  render(
    <GridCell
      column={{ name: "v", type: "text", width: 120, numeric: false, ...column }}
      value={value}
      col={0}
      active={false}
      height={32}
    />
  );

  return screen.getByRole("gridcell");
};

test("NULL and the empty string read as placeholders, not as the text 'NULL'", () => {
  const spoken = [null, "", "NULL"].map((value) => {
    const cell = cellFor(value);
    const said = [cell.getAttribute("aria-label"), cell.className.includes("italic")];

    cleanup();

    return said;
  });

  expect(spoken).toEqual([
    ["null", true],
    ["empty string", true],
    [null, false],
  ]);
});

test("a foreign key whose value can't be matched isn't a link, and says why", () => {
  const cell = cellFor(DataValueTags.cases.Bytes.make({ length: 2, preview: "\\x0102" }), {
    fk: { schema: "public", table: "files", column: "hash" },
  });

  expect(cell.dataset["fk"]).toBeUndefined();
  expect(cell.title).toContain("binary");
});
