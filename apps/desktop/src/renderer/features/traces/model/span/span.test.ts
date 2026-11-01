import type { Span } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { FIXTURE_SOURCES } from "../../../data/preview/fixtures.ts";
import {
  BIG_TRACE,
  ERROR_TRACE,
  FIXTURE_CHECKOUT,
  FIXTURE_DETAILS,
  FIXTURE_TURNS,
} from "../../preview/fixtures.ts";
import { codeLocation, exceptionOf, locationLabel, stackFrames } from "./code.ts";
import { spanDataSource, spanTable } from "./dataSource.ts";
import { filterFields, spanFieldGroups } from "./fields.ts";

const spanOf = (traceId: string, spanId: string): Span => {
  const span = FIXTURE_DETAILS.find((d) => d.summary.id === traceId)?.spans.find(
    (s) => s.id === spanId
  );

  if (span === undefined) throw new Error(`no fixture span ${spanId}`);

  return span;
};

const UPDATE = spanOf(BIG_TRACE.id, "a91f5d6e7b8c03c2");

const TEST_ROOT = spanOf(ERROR_TRACE.id, "3c5d7e9f1a2b4c6d");

const CHECKOUT = FIXTURE_CHECKOUT.checkout;

const polarisGroup = (span: Span) =>
  spanFieldGroups(span, "Fix overdue totals").find((g) => g.name === "polaris")?.fields;

describe("fields", () => {
  test("the polaris group names the session and Turn, and leaves out a null launchedTurn", () => {
    expect(polarisGroup(UPDATE)).toEqual([
      { key: "agent session", value: "Fix overdue totals" },
      { key: "turn", value: "12" },
    ]);
  });

  test("a launchedTurn adds when the process started", () => {
    const launched: Span = {
      ...UPDATE,
      polaris: { ...UPDATE.polaris, launchedTurn: { ...FIXTURE_TURNS[10], number: 9 } },
    };

    expect(polarisGroup(launched)?.[1]).toEqual({
      key: "turn",
      value: "12",
      note: "process started in turn 9",
    });
  });

  test("a span between Turns from a Workspace terminal says so", () => {
    const terminal: Span = {
      ...UPDATE,
      polaris: { ...UPDATE.polaris, sessionId: null, turn: null },
    };

    expect(polarisGroup(terminal)?.map((f) => f.value)).toEqual([
      "a terminal in this workspace",
      "between turns",
    ]);
  });

  test("the filter keeps fields matching by key or value, any case, and drops empty groups", () => {
    const groups = spanFieldGroups(UPDATE, null);

    const byValue = filterFields(groups, "POSTGRES");

    expect(byValue.map((g) => [g.name, g.fields.map((f) => f.key)])).toEqual([
      ["attributes", ["db.system.name"]],
    ]);
    expect(filterFields(groups, "server.").flatMap((g) => g.fields.map((f) => f.key))).toEqual([
      "server.address",
      "server.port",
    ]);
  });

  test("a group's name keeps the whole group; a blank filter keeps everything", () => {
    const groups = spanFieldGroups(UPDATE, null);

    expect(filterFields(groups, "scope")).toEqual(groups.filter((g) => g.name === "scope"));
    expect(filterFields(groups, "  ")).toBe(groups);
  });

  test("int64 and structured attribute values read as text; queries are marked as SQL", () => {
    const span: Span = {
      ...UPDATE,
      attributes: { count: "9007199254740993", tags: ["a", 1], "db.query.text": "select 1" },
    };

    const fields = spanFieldGroups(span, null)[0]?.fields;

    expect(fields).toEqual([
      { key: "count", value: "9007199254740993" },
      { key: "db.query.text", value: "select 1", sql: true },
      { key: "tags", value: '["a",1]' },
    ]);
  });
});

describe("code location", () => {
  test("reads the current and the old attribute names, int64 lines included", () => {
    expect(codeLocation(UPDATE.attributes, CHECKOUT)).toEqual({
      path: "src/invoices/overdue.ts",
      line: 61,
      column: null,
    });
    expect(
      codeLocation({ "code.filepath": `${CHECKOUT}/src/a.ts`, "code.lineno": "7" }, CHECKOUT)
    ).toEqual({ path: "src/a.ts", line: 7, column: null });
  });

  test("labels by the file's name and line", () => {
    expect(locationLabel({ path: "src/invoices/overdue.ts", line: 61, column: null })).toBe(
      "overdue.ts:61"
    );
  });

  test("a span with no code path has no location", () => {
    expect(codeLocation({ "code.line.number": 3 }, CHECKOUT)).toBeNull();
  });
});

describe("exception stacks", () => {
  test("the checkout's frames come first; dependencies, the runtime and other folders after", () => {
    const stack = [
      "TypeError: nope",
      "    at Module.run (node:internal/modules/run:12:3)",
      "    at load (/Users/lucas/other/x.ts:1:1)",
      "    at runTest (node_modules/bun-test/run.js:88:5)",
      `    at async saveTotals (file://${CHECKOUT}/src/invoices/overdue.ts:61:9)`,
      "    at test/overdue-totals.test.ts:42:18",
    ].join("\n");

    const frames = stackFrames(stack, CHECKOUT);

    expect(frames.map((f) => [f.fn, f.location.path, f.inProject])).toEqual([
      ["saveTotals", "src/invoices/overdue.ts", true],
      [null, "test/overdue-totals.test.ts", true],
      ["Module.run", "node:internal/modules/run", false],
      ["load", "/Users/lucas/other/x.ts", false],
      ["runTest", "node_modules/bun-test/run.js", false],
    ]);
  });

  test("an exception event reads as type, message and frames; other events are not exceptions", () => {
    const [event] = TEST_ROOT.events;

    if (event === undefined) throw new Error("the fixture's test root has an exception");
    const exception = exceptionOf(event, CHECKOUT);

    expect(exception?.type).toBe("AssertionError");
    expect(exception?.message?.split("\n")[0]).toBe("expect(received).toBe(expected)");
    expect(exception?.frames[0]?.location).toEqual({
      path: "test/overdue-totals.test.ts",
      line: 42,
      column: 18,
    });
    expect(exceptionOf({ ...event, name: "retry" }, CHECKOUT)).toBeNull();
  });
});

describe("Open in Data", () => {
  test("a database span finds its Data Source by engine, database, host and port", () => {
    expect(spanDataSource(UPDATE.attributes, FIXTURE_SOURCES)?.name).toBe("app");
  });

  test("loopback names match each other; another port or database doesn't", () => {
    const at = (patch: Record<string, string | number>) =>
      spanDataSource({ ...UPDATE.attributes, ...patch }, FIXTURE_SOURCES)?.name ?? null;

    expect(at({ "server.address": "127.0.0.1" })).toBe("app");
    expect(at({ "server.port": 5433 })).toBeNull();
    expect(at({ "db.namespace": "ledger_overdue|public" })).toBe("app");
    expect(at({ "db.namespace": "other" })).toBeNull();
    expect(at({ "db.system.name": "mariadb" })).toBeNull();
  });

  test("a span that isn't a database call has no Data Source", () => {
    expect(spanDataSource(TEST_ROOT.attributes, FIXTURE_SOURCES)).toBeNull();
  });

  test("the table is db.collection.name, else the one the query names", () => {
    expect(spanTable(UPDATE.attributes)).toEqual({ schema: null, name: "invoices" });
    expect(spanTable({ "db.collection.name": "customers" })).toEqual({
      schema: null,
      name: "customers",
    });
    expect(spanTable({ "db.query.text": "select 1" })).toBeNull();
  });
});
