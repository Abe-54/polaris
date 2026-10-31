/** RE's findings on grid edits (ENG-645), through the real grid, store and fixture api. */
import {
  DataEditConflict,
  DataSource,
  DataValueTags,
  DataWriteResult,
  TableDetail,
} from "@polaris/protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import type { CommitEditsInput, DataApi } from "../../../data/api.ts";
import type { DataRow } from "../../../grid/value.ts";
import { openTable } from "../../../model/store.ts";
import { fixtureDataApi } from "../../../preview/fixtureApi.ts";
import { FIXTURE_SOURCES } from "../../../preview/fixtures.ts";
import { at, cell, footer, grid, installGridHarness, mount, tabOn } from "./edits.testing.tsx";
import { connectShelf, editsOf, editsStore } from "./store.ts";
import { FLOAT_KEY, NO_KEY_ORDER } from "./useTableEdits.ts";

installGridHarness();

const { Changed, Missing } = DataEditConflict.cases;

const { Timestamp } = DataValueTags.cases;

type Col = TableDetail["columns"][number];

const col = (name: string, type: string, pk = false): Col => ({
  name,
  type,
  nullable: true,
  default: null,
  pk,
  fk: null,
});

const table = (name: string, columns: ReadonlyArray<Col>, primaryKey?: ReadonlyArray<string>) => {
  const detail = { schema: "public", name, columns, indexes: [], constraints: [], rowEstimate: 3 };

  // An older Daemon's detail has no declared key order.
  return new TableDetail(primaryKey === undefined ? detail : { ...detail, primaryKey });
};

/** The Daemon's real shapes: int4 as a number, timestamptz as Timestamp, MySQL bool as 0/1. */
const TYPED = table(
  "ef_typed",
  [
    col("id", "integer", true),
    col("n", "integer"),
    col("ts", "timestamp with time zone"),
    col("b", "tinyint(1)"),
    col("t", "text"),
    col("local", "timestamp without time zone"),
  ],
  ["id"]
);

const TYPED_ROWS: ReadonlyArray<DataRow> = [
  [1, 42, Timestamp.make({ iso: "2026-10-30T06:30:00.123456+00:00" }), 1, "one\r\ntwo", null],
  [2, 7, Timestamp.make({ iso: "2026-10-30T07:00:00+00:00" }), 0, "x", null],
  [3, 9, null, 1, "y", null],
];

const COL = { id: 0, n: 1, ts: 2, b: 3, t: 4, local: 5 } as const;

type Answer = (
  input: CommitEditsInput
) => Promise<Awaited<ReturnType<NonNullable<DataApi["commitEdits"]>>>>;

const OK: Answer = async (input) => ({
  ok: true,
  value: new DataWriteResult({ queryId: "q", affected: input.edits.length, elapsedMs: 2 }),
});

/** A fixture Host serving `tables`, recording each commit and answering with `answer`. */
const host = (
  tables: Record<string, { detail: TableDetail; rows: ReadonlyArray<DataRow> }>,
  answer: Answer = OK,
  sources?: ReadonlyArray<DataSource>
) => {
  const sent: Array<CommitEditsInput> = [];
  const base = fixtureDataApi(sources === undefined ? { tables } : { tables, sources });

  const api: DataApi = {
    ...base,
    commitEdits: async (_at, input) => {
      sent.push(input);

      return answer(input);
    },
  };

  return { api, sent };
};

const typed = (answer?: Answer, rows = TYPED_ROWS) =>
  host({ ef_typed: { detail: TYPED, rows } }, answer);

const ready = (n: number) =>
  waitFor(() => expect(footer()).toStartWith(`${n} ${n === 1 ? "row" : "rows"} · `));

const open = (row: number, column: number, key = "Enter") => {
  fireEvent.mouseDown(cell(row, column), { button: 0 });
  fireEvent.keyDown(grid(), { key });

  return screen.getByTestId("data-cell-editor-field");
};

const commit = () => act(async () => void fireEvent.click(screen.getByTestId("data-commit")));

test("F4: ↵ ↵ or clicking away from an untouched editor stages nothing, on every value shape", async () => {
  mount(typed().api, tabOn("app", "ef_typed"));
  await ready(3);

  for (const column of [COL.n, COL.ts, COL.b, COL.t]) {
    fireEvent.keyDown(open(0, column), { key: "Enter" });
    expect(screen.queryByTestId("data-cell-editor")).toBeNull();
    fireEvent.focusOut(open(1, column));
  }

  expect(screen.queryByTestId("data-staged")).toBeNull();
});

test("F4: typing a value the column stores alike is a no-op", async () => {
  mount(typed().api, tabOn("app", "ef_typed"));
  await ready(3);

  for (const [column, text] of [
    [COL.n, "42.0"],
    [COL.ts, "2026-10-30 12:00:00.123456+05:30"],
    [COL.t, "one\ntwo"],
  ] as const) {
    const field = open(0, column);

    fireEvent.change(field, { target: { value: text } });
    fireEvent.keyDown(field, { key: "Enter" });
  }

  expect(screen.queryByTestId("data-staged")).toBeNull();
});

test("F6: an offset on a column without a zone is refused, and the local time is offered", async () => {
  const { api, sent } = typed();

  mount(api, tabOn("app", "ef_typed"));
  await ready(3);
  const field = open(0, COL.local);

  fireEvent.change(field, { target: { value: "2026-08-02 09:30:00+05:30" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.getByTestId("data-cell-editor-note").textContent).toBe(
    "This column has no time zone; write a local time"
  );

  fireEvent.click(screen.getByTestId("data-cell-editor-suggestion"));
  fireEvent.keyDown(screen.getByTestId("data-cell-editor-field"), { key: "Enter" });
  await commit();
  expect(sent[0]?.edits[0]?.value).toEqual(Timestamp.make({ iso: "2026-08-02 09:30:00" }));
});

test("F9: ⌘S inside an open editor stages the draft, then commits it", async () => {
  const { api, sent } = typed();

  mount(api, tabOn("app", "ef_typed"));
  await ready(3);
  const field = open(0, COL.n);

  fireEvent.change(field, { target: { value: "43" } });
  await act(async () => void fireEvent.keyDown(field, { key: "s", code: "KeyS", metaKey: true }));

  expect(sent).toHaveLength(1);
  expect(sent[0]?.edits).toEqual([
    { key: [1], column: "n", before: 42, value: DataValueTags.cases.Numeric.make({ value: "43" }) },
  ]);
});

test("F10: ↵ while an IME composes stays in the editor; a composition or ⌥ key starts an edit", async () => {
  mount(typed().api, tabOn("app", "ef_typed"));
  await ready(3);
  const field = open(0, COL.t);

  fireEvent.change(field, { target: { value: "にほn" } });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
  expect(screen.getByTestId("data-cell-editor")).toBeDefined();
  expect(screen.queryByTestId("data-staged")).toBeNull();
  fireEvent.keyDown(field, { key: "Escape" });

  fireEvent.mouseDown(cell(1, COL.t), { button: 0 });
  fireEvent.keyDown(grid(), { key: "Process", keyCode: 229 });
  expect(screen.getByTestId("data-cell-editor-field")).toHaveProperty("value", "");
  fireEvent.keyDown(screen.getByTestId("data-cell-editor-field"), { key: "Escape" });

  fireEvent.mouseDown(cell(2, COL.t), { button: 0 });
  fireEvent.keyDown(grid(), { key: "ø", altKey: true });
  expect(screen.getByTestId("data-cell-editor-field")).toHaveProperty("value", "ø");
});

test("F11: a text cell edits in a multi-line field, so pasted line breaks are kept", async () => {
  const { api, sent } = typed();

  mount(api, tabOn("app", "ef_typed"));
  await ready(3);
  const field = open(1, COL.t);

  expect(field.tagName).toBe("TEXTAREA");
  fireEvent.change(field, { target: { value: "12 Main St\nSpringfield" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await commit();
  expect(sent[0]?.edits[0]?.value).toBe("12 Main St\nSpringfield");
});

test("F3: a key declared out of column order commits in its declared order", async () => {
  const junction = table(
    "ef_junction",
    [col("a", "integer", true), col("b", "integer", true), col("v", "integer")],
    ["b", "a"]
  );

  const { api, sent } = host({ ef_junction: { detail: junction, rows: [[1, 2, 10]] } });

  mount(api, tabOn("app", "ef_junction"));
  await ready(1);
  const field = open(0, 2);

  fireEvent.change(field, { target: { value: "11" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await commit();
  expect(sent[0]?.primaryKey).toEqual(["b", "a"]);
  expect(sent[0]?.edits[0]?.key).toEqual([2, 1]);
});

test("F3/F14: an unknown key order or a floating-point key is read-only with the reason", async () => {
  const old = table("ef_old", [
    col("a", "integer", true),
    col("b", "integer", true),
    col("v", "integer"),
  ]);

  const float = table("ef_float", [col("r", "real", true), col("v", "integer")], ["r"]);

  mount(host({ ef_old: { detail: old, rows: [[1, 2, 3]] } }).api, tabOn("app", "ef_old"));
  await ready(1);
  expect(screen.getByTestId("data-read-only").textContent).toBe(`Read-only · ${NO_KEY_ORDER}`);
  cleanup();

  mount(host({ ef_float: { detail: float, rows: [[0.1, 3]] } }).api, tabOn("app", "ef_float"));
  await ready(1);
  expect(screen.getByTestId("data-read-only").textContent).toBe(`Read-only · ${FLOAT_KEY}`);
});

test("F13: a local source set to read only can't be edited", async () => {
  const app = FIXTURE_SOURCES.find((s) => s.name === "app");

  if (app === undefined) throw new Error("no app fixture");
  const off = new DataSource({ ...Schema.encodeSync(DataSource)(app), writes: "off" });
  const sources = FIXTURE_SOURCES.map((s) => (s.name === "app" ? off : s));

  mount(
    host({ ef_typed: { detail: TYPED, rows: TYPED_ROWS } }, OK, sources).api,
    tabOn("app", "ef_typed")
  );
  await ready(3);
  expect(screen.getByTestId("data-read-only").textContent).toStartWith(
    "Read-only · Writes are off for this data source"
  );
  fireEvent.mouseDown(cell(0, COL.n), { button: 0 });
  fireEvent.keyDown(grid(), { key: "Enter" });
  expect(screen.queryByTestId("data-cell-editor")).toBeNull();
});

const conflicted: Answer = async () => ({
  ok: false,
  error: {
    code: "E-DATA-CONFLICT",
    message: "Some staged cells changed or their rows no longer exist. Nothing was written.",
    fix: "Overwrite or drop each conflict, then commit again.",
    conflicts: [Changed.make({ key: [1], column: "n", value: 99 }), Missing.make({ key: [2] })],
  },
});

test("F2/F5: a conflict marks the cell with the newer value, a gone row is listed and not counted", async () => {
  let answer = conflicted;
  const { api, sent } = typed((input) => answer(input));

  mount(api, tabOn("app", "ef_typed"));
  await ready(3);

  for (const row of [0, 1]) {
    const field = open(row, COL.n);

    fireEvent.change(field, { target: { value: "11" } });
    fireEvent.keyDown(field, { key: "Enter" });
  }

  await commit();

  expect(cell(0, COL.n).dataset["staged"]).toBe("conflict");
  const lines = screen.getAllByTestId("data-conflict").map((l) => l.textContent);

  expect(lines).toEqual([
    "id = 1 · nChanged since you staged it · was 42, now 99 · yours 11OverwriteDrop edit",
    "id = 2Row no longer exists · 1 changeDrop edit",
  ]);
  expect(footer()).toContain("1 change staged · 1 row");
  expect(screen.getByTestId("data-commit")).toHaveProperty("disabled", true);

  answer = OK;
  fireEvent.click(screen.getByTestId("data-conflict-overwrite"));
  await commit();
  expect(sent[1]?.edits).toEqual([
    { key: [1], column: "n", before: 99, value: DataValueTags.cases.Numeric.make({ value: "11" }) },
  ]);

  fireEvent.click(screen.getByTestId("data-conflict-drop"));
  expect(screen.queryByTestId("data-conflicts")).toBeNull();
  expect(editsOf(at, tabOn("app", "ef_typed").id).staged.cells.size).toBe(0);
});

test("F5: a staged row missing from the rows read again is listed, not counted and not sent", async () => {
  const { api, sent } = typed();

  mount(api, tabOn("app", "ef_typed"));
  await ready(3);

  for (const row of [0, 1]) {
    const field = open(row, COL.n);

    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.keyDown(field, { key: "Enter" });
  }

  cleanup();

  const again = typed(OK, [TYPED_ROWS[0] ?? [], TYPED_ROWS[2] ?? []]);

  mount(again.api, tabOn("app", "ef_typed"));
  await ready(2);
  expect(footer()).toContain("1 change staged · 1 row");
  expect(screen.getByTestId("data-conflict").textContent).toBe(
    "id = 2Row not shown · 1 changeDrop edit"
  );
  await commit();
  expect(again.sent[0]?.edits.map((e) => e.key)).toEqual([[1]]);
  expect(sent).toEqual([]);
});

test("F12: Discard of more than one edit can be undone from its toast", async () => {
  mount(typed().api, tabOn("app", "ef_typed"));
  await ready(3);

  for (const row of [0, 1]) {
    const field = open(row, COL.n);

    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.keyDown(field, { key: "Enter" });
  }

  fireEvent.click(screen.getByTestId("data-discard"));
  expect(screen.queryByTestId("data-staged")).toBeNull();

  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(footer()).toContain("2 changes staged · 2 rows");
});

/** A Storage held in memory, as the window's localStorage across a reload. */
const memoryStorage = (): Storage => {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
};

test("F12: staged edits come back after a reload, per agent session and tab", async () => {
  const storage = memoryStorage();
  const disconnect = connectShelf(storage);

  mount(typed().api, tabOn("app", "ef_typed"));
  await ready(3);
  const field = open(0, COL.n);

  fireEvent.change(field, { target: { value: "5" } });
  fireEvent.keyDown(field, { key: "Enter" });
  disconnect();
  cleanup();

  // The reload: an empty store, then the shelf read back.
  editsStore.setState({ tabs: {}, closing: null });
  connectShelf(storage)();
  mount(typed().api, tabOn("app", "ef_typed"));
  await ready(3);
  expect(footer()).toContain("1 change staged · 1 row");
  expect(cell(0, COL.n).dataset["staged"]).toBe("true");
});

test("F15: closing a tab during a commit says Committing… and closes once it lands", async () => {
  let land = () => {};

  const gate = new Promise<void>((resolve) => (land = resolve));

  const { api } = typed(async (input) => {
    await gate;

    return OK(input);
  });

  act(() => openTable("app", { schema: "public", name: "ef_typed" }, at));
  mount(api, tabOn("app", "ef_typed"), "strip");
  await ready(3);
  const field = open(0, COL.n);

  fireEvent.change(field, { target: { value: "5" } });
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.click(screen.getByTestId("data-commit"));
  fireEvent.click(screen.getByLabelText("Close ef_typed"));

  const dialog = await screen.findByTestId("data-close-staged");

  expect(dialog.textContent).toContain("Committing changes to ef_typed…");
  expect(screen.queryByTestId("data-close-discard")).toBeNull();

  await act(async () => {
    land();
    await gate;
  });
  await waitFor(() => expect(screen.queryAllByTestId("data-tab")).toHaveLength(0));
  expect(Object.keys(editsStore.getState().tabs)).toEqual([]);
});
