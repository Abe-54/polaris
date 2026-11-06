import { describe, expect, test } from "bun:test";
import { layColumns, MAX_WIDTH } from "./columns.ts";
import { toCsv } from "./csv.ts";
import { indentJson } from "./json.ts";
import { appendBlock, blockBudget, rowsBlock } from "./rows.ts";
import { emptySelection, moveActive, selectAll, selectCell, selectedRows } from "./selection.ts";
import {
  cellOf,
  type DataValue,
  DataValueTags,
  DISPLAY_CHARS,
  displayOf,
  formatSize,
} from "./value.ts";

const { BigInt, Bytes, Numeric, Timestamp, Truncated } = DataValueTags.cases;

const shown = (value: DataValue) => displayOf(cellOf(value));

describe("cell display", () => {
  test.each([
    [null, "NULL"],
    [48200, "48 200"],
    [BigInt.make({ value: "-9007199254740993" }), "-9 007 199 254 740 993"],
    [Numeric.make({ value: "304000.50" }), "304 000.50"],
    ["9f2c41aa-0000-4000-8000-00000000041a", "9f2c…41a"],
    ["two\nlines", "two⏎lines"],
    [Timestamp.make({ iso: "2026-08-02T09:30:00.000Z" }), "2026-08-02 09:30:00Z"],
    [Timestamp.make({ iso: "2026-10-30T12:00:00.000+05:30" }), "2026-10-30 12:00:00+05:30"],
    ["2026-10-30T09:00 standup", "2026-10-30T09:00 standup"],
    ["INV-2041", "INV-2041"],
    ["12345", "12345"],
    ["a\tb\rc\r\nd\u2028e\u0085f", "a⇥b␍c⏎d⏎e⏎f"],
    ["invoice_\u202Efdp.exe", "invoice_⟨RLO⟩fdp.exe"],
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

  test("a long number, text that starts like a time, or a non-number in a numeric column is clipped first", () => {
    const log = `2026-10-30T12:00 ${"x".repeat(1_000_000)}`;
    const notANumber = `${"9".repeat(10)}\n${"x".repeat(5_000)}`;

    expect(shown(log)).toHaveLength(DISPLAY_CHARS + 1);
    expect(shown(Numeric.make({ value: "1".repeat(300) }))).toBe(`${"1".repeat(DISPLAY_CHARS)}…`);
    expect(displayOf(cellOf(notANumber), { numeric: true })).toBe(
      `${"9".repeat(10)}⏎${"x".repeat(DISPLAY_CHARS - 11)}…`
    );
  });

  test("the inspector counts characters, and the database's size in bytes", () => {
    expect(formatSize(1_000_000, "characters")).toBe("1.0M characters");
    expect(formatSize(980, "characters")).toBe("980 characters");
    expect(formatSize(1_048_576, "bytes")).toBe("1.0 MB");
  });
});

describe("columns", () => {
  test("numeric types right-align; a foreign key's header names its table", () => {
    const [id, total, customer] = layColumns(
      [
        { name: "id", type: "uuid" },
        { name: "total_cents", type: "int8" },
        {
          name: "customer_id",
          type: "uuid",
          fk: { schema: "public", table: "customers", column: "id" },
        },
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

describe("JSON in the inspector", () => {
  test.each([
    ['{"amount": 12345678901234567890}', '{\n  "amount": 12345678901234567890\n}'],
    [
      '{"p":0.1000000000000000055511,"n":1.50}',
      '{\n  "p": 0.1000000000000000055511,\n  "n": 1.50\n}',
    ],
    ['{"a":1,"a":2}', '{\n  "a": 1,\n  "a": 2\n}'],
    ['{"b":1,"2":0,"1":0}', '{\n  "b": 1,\n  "2": 0,\n  "1": 0\n}'],
    ['{"s":"a, b: {c}","e":[],"o":{}}', '{\n  "s": "a, b: {c}",\n  "e": [],\n  "o": {}\n}'],
    ['{"q":"say \\"hi\\""}', '{\n  "q": "say \\"hi\\""\n}'],
  ])("%s keeps every lexeme as stored", (stored, indented) => {
    expect(indentJson(stored)).toBe(indented);
  });

  test("text that isn't whole JSON comes back unchanged", () => {
    expect(indentJson('{"items": [1, 2')).toBe('{"items": [1, 2');
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

  test("NULL, the empty string and the text NULL stay three different fields", () => {
    const columns = [{ name: "v", type: "text" }];
    const rows = [[null], [""], ["NULL"]];

    expect(toCsv(columns, rows)).toBe('v\r\n\r\n""\r\nNULL\r\n');
    expect(toCsv(columns, rows, { nullToken: "NULL" })).toBe('v\r\nNULL\r\n\r\n"NULL"\r\n');
  });

  test("text a spreadsheet would run as a formula goes out inert; negative numbers don't", () => {
    const csv = toCsv(
      [
        { name: "note", type: "text" },
        { name: "n", type: "int4" },
      ],
      [
        ['=HYPERLINK("http://x.test","click")', -5],
        ["+cmd|' /C calc'!A0", 1],
        ["-2+3", 2],
        ["@SUM(1,1)", 3],
        ["\t=1+1", 4],
        ["\r=1+1", 5],
      ]
    );

    expect(csv.split("\r\n").slice(1, -1)).toEqual([
      `"'=HYPERLINK(""http://x.test"",""click"")",-5`,
      "'+cmd|' /C calc'!A0,1",
      "'-2+3,2",
      `"'@SUM(1,1)",3`,
      "'\t=1+1,4",
      `"'\r=1+1",5`,
    ]);
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

    expect(block.text.split("\n")[0]).toBe("1 row from `app` · `public.invoices`:");
    expect(block.text).toContain("`````csv\nnote\na ```` b\n`````\n");
  });

  test("NULL is spelled out, text NULL quoted, formulas left raw, and a cut value says so", () => {
    const { text } = rowsBlock({
      source: "app",
      from: "events",
      columns: [
        { name: "a", type: "text" },
        { name: "b", type: "text" },
        { name: "c", type: "text" },
        { name: "d", type: "jsonb" },
      ],
      rows: [[null, "NULL", "=1+1", Truncated.make({ preview: '{"a":1', bytes: 1_048_576 })]],
    });

    expect(text).toContain('\nNULL,"NULL",=1+1,"{""a"":1…(cut short: 1.0 MB in the database)"\n');
  });

  test("the block keeps to the budget, row by row, and says how many of how many it holds", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => [i, "x".repeat(300)]);

    const source = {
      source: "app",
      from: "events",
      columns: [
        { name: "id", type: "int8" },
        { name: "note", type: "text" },
      ],
      rows,
    };

    const draft = "Look at these:";
    const budget = blockBudget(draft, 100_000);
    const block = rowsBlock(source, budget);

    expect(appendBlock(draft, block.text).length).toBeLessThanOrEqual(100_000);
    expect(appendBlock(draft, rowsBlock(source, budget + 400).text).length).toBeGreaterThan(
      100_000 - 400
    );
    expect(block.text.split("\n")[0]).toBe(
      `The first ${block.rows} rows of 10,000 selected from \`app\` · \`events\`:`
    );
    expect(block.text.trimEnd().split("\n")).toHaveLength(block.rows + 4);
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
