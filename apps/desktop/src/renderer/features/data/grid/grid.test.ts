import { describe, expect, test } from "bun:test";
import { layColumns, MAX_WIDTH } from "./columns.ts";
import { toCsv } from "./csv.ts";
import { rowsBlock } from "./rows.ts";
import { emptySelection, moveActive, selectAll, selectCell, selectedRows } from "./selection.ts";
import { Option } from "effect";
import {
  cellOf,
  type DataValue,
  DataValueTags,
  decodeRows,
  DISPLAY_CHARS,
  displayOf,
} from "./value.ts";

const { BigInt, Bytes, Json, Numeric, Timestamp, Truncated } = DataValueTags.cases;

const shown = (value: DataValue) => displayOf(cellOf(value));

describe("cell display", () => {
  test.each([
    [null, "NULL"],
    [48200, "48 200"],
    [BigInt.make({ value: "-9007199254740993" }), "-9 007 199 254 740 993"],
    [Numeric.make({ value: "304000.50" }), "304 000.50"],
    ["9f2c41aa-0000-4000-8000-00000000041a", "9f2c…41a"],
    ["two\nlines", "two⏎lines"],
    [Timestamp.make({ iso: "2026-08-02T00:00:00Z" }), "2026-08-02T00:00:00Z"],
    [Bytes.make({ length: 16 }), "16 bytes"],
    [Truncated.make({ preview: '{"a":1', bytes: 1_048_576 }), '{"a":1…'],
  ])("%p shows as %p", (value, text) => {
    expect(shown(value)).toBe(text);
  });

  test("a long value is clipped for the grid but kept whole for copying", () => {
    const long = "x".repeat(DISPLAY_CHARS + 50);

    expect(shown(long)).toHaveLength(DISPLAY_CHARS + 1);
    expect(cellOf(long).raw).toBe(long);
  });

  test("rows parse at the boundary, and a cell that isn't a data value fails the result", () => {
    expect(decodeRows(JSON.parse('[[1, null, {"_tag": "Json", "text": "{}"}]]'))).toEqual(
      Option.some([[1, null, Json.make({ text: "{}" })]])
    );
    expect(Option.isNone(decodeRows([[{ unexpected: [1] }]]))).toBe(true);
  });

  test("a numeric-looking string in a text column isn't grouped", () => {
    expect(shown("INV-2041")).toBe("INV-2041");
    expect(shown("12345")).toBe("12345");
  });
});

describe("columns", () => {
  test("numeric types right-align; a foreign key's header names its table", () => {
    const [id, total, customer] = layColumns(
      [
        { name: "id", type: "uuid" },
        { name: "total_cents", type: "int8" },
        { name: "customer_id", type: "uuid", fk: { table: "customers", column: "id" } },
      ],
      []
    );

    expect([id?.numeric, total?.numeric, customer?.numeric]).toEqual([false, true, false]);
    expect(customer?.width).toBeGreaterThan(id?.width ?? 0);
  });

  test("a column of numbers typed as text right-aligns, and a huge value can't widen past the cap", () => {
    const [count, body] = layColumns(
      [
        { name: "count", type: "text" },
        { name: "body", type: "json" },
      ],
      [
        [12, "x".repeat(10_000)],
        [7, null],
      ]
    );

    expect(count?.numeric).toBe(true);
    expect(body?.width).toBe(MAX_WIDTH);
  });
});

describe("CSV", () => {
  test("quotes what needs it, leaves NULL empty and writes tagged values raw", () => {
    const csv = toCsv(
      [
        { name: "note", type: "text" },
        { name: "paid_at", type: "timestamptz" },
        { name: "total", type: "numeric" },
      ],
      [
        ['say "hi", then\nleave', null, Numeric.make({ value: "48200.00" })],
        ["plain", Timestamp.make({ iso: "2026-08-02T00:00:00Z" }), 3],
      ]
    );

    expect(csv).toBe(
      'note,paid_at,total\r\n"say ""hi"", then\nleave",,48200.00\r\nplain,2026-08-02T00:00:00Z,3\r\n'
    );
  });
});

describe("rows for an agent session", () => {
  test("the fence outgrows any backtick run inside the rows", () => {
    const block = rowsBlock({
      source: "app",
      from: "public.invoices",
      columns: [{ name: "note", type: "text" }],
      rows: [["a ```` b"]],
    });

    expect(block.split("\n")[0]).toBe("1 row from `app` · `public.invoices`:");
    expect(block).toContain("`````csv\nnote\na ```` b\n`````\n");
  });
});

describe("selection", () => {
  test("⇧-click selects the range from the anchor; ⌘-click toggles one row", () => {
    let s = selectCell(emptySelection, { row: 4, col: 0 });

    s = selectCell(s, { row: 1, col: 2 }, { range: true });
    expect(selectedRows(s)).toEqual([1, 2, 3, 4]);

    s = selectCell(s, { row: 3, col: 0 }, { toggle: true });
    expect(selectedRows(s)).toEqual([1, 2, 4]);
  });

  test("arrows stop at the edges and ⇧ extends", () => {
    const size = { rows: 3, cols: 2 };
    let s = moveActive(emptySelection, "down", size);

    expect(s.active).toEqual({ row: 0, col: 0 });
    s = moveActive(s, "up", size);
    s = moveActive(s, "left", size);
    expect(s.active).toEqual({ row: 0, col: 0 });
    s = moveActive(s, "end", size, { range: true });
    expect(selectedRows(s)).toEqual([0, 1, 2]);
  });

  test("select all takes every row, and nothing on an empty grid", () => {
    expect(selectedRows(selectAll(emptySelection, 3))).toEqual([0, 1, 2]);
    expect(selectAll(emptySelection, 0)).toBe(emptySelection);
  });
});
