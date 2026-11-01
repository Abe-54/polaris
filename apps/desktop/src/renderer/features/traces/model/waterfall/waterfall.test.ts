import { describe, expect, test } from "bun:test";
import { buildTrace } from "../../preview/build.ts";
import { BIG_TRACE, ERROR_TRACE, FIXTURE_CHECKOUT, PARTIAL_TRACE } from "../../preview/fixtures.ts";
import {
  focusOf,
  NO_FOCUS,
  parentKeys,
  type SpanNode,
  spanTree,
  tableRows,
  traceTimes,
  waterfallRows,
} from "./index.ts";

const big = traceTimes(buildTrace(BIG_TRACE, FIXTURE_CHECKOUT));

const failing = traceTimes(buildTrace(ERROR_TRACE, FIXTURE_CHECKOUT));

const partial = traceTimes(buildTrace(PARTIAL_TRACE, FIXTURE_CHECKOUT));

const names = (nodes: ReadonlyArray<SpanNode>) =>
  nodes.map((n) => (n.fold ? `${n.name} ×${n.spans.length}` : n.name));

const UNFOCUSED = { collapsed: new Set<string>(), focus: null };

describe("traceTimes", () => {
  test("counts levels and services in order of appearance, with each one's wall time", () => {
    expect(big.levels).toBe(4);
    expect(big.end).toBeCloseTo(840, 6);
    expect(big.services.map((s) => [s.name, s.index, s.spans, Math.round(s.ms)])).toEqual([
      ["ledger-api", 0, 220, 840],
      ["fx-rates", 1, 214, 636],
    ]);
  });

  test("a span's self time leaves out the time its children cover", () => {
    const root = big.spans.find((s) => s.span.parentId === null);

    // Children: auth 2–8, recalculate 10–824, res.json 828–836.
    expect(root?.self).toBeCloseTo(840 - 6 - 814 - 8, 6);
  });

  test("a span whose parent wasn't retained is a root, marked as such", () => {
    const roots = spanTree(partial);

    expect(roots.map((n) => [n.name, n.orphan])).toEqual([
      ["POST /invoices/import", false],
      ["INSERT invoices", true],
    ]);
  });
});

describe("spanTree", () => {
  const [root] = spanTree(big);
  const recalculate = root?.children.find((n) => n.name === "invoices.recalculateOverdue");

  test("repeated siblings fold into one ×n node, and so do their merged children", () => {
    expect(names(root?.children ?? [])).toEqual([
      "auth.verifySession",
      "invoices.recalculateOverdue",
      "res.json",
    ]);
    expect(names(recalculate?.children ?? [])).toEqual([
      "SELECT invoices",
      "GET fx-rates.internal/rates ×214",
      "UPDATE invoices",
    ]);

    const calls = recalculate?.children[1];

    expect(names(calls?.children ?? [])).toEqual(["GET /rates ×214"]);
    expect(calls?.children[0]?.newService).toBe(true);
  });

  test("a parent's badge counts every span under it (Paper T1: 433 and 430)", () => {
    expect([root?.descendants, recalculate?.descendants]).toEqual([433, 430]);
  });

  test("a fold sums its calls' durations and spans their extent", () => {
    const calls = recalculate?.children[1];

    expect(calls?.duration).toBeCloseTo(640 * 0.9997, 3);
    expect(calls?.start).toBeCloseTo(58, 6);
    expect(calls?.end).toBeCloseTo(58 + 640 * (213 / 214) + (640 / 214) * 0.9997, 3);
  });

  test("an expanded fold lists each call", () => {
    const fold = recalculate?.children[1]?.key ?? "";
    const [open] = spanTree(big, new Set([fold]));
    const calls = open?.children[1]?.children.filter((n) => n.name.startsWith("GET fx-rates"));

    expect(calls?.length).toBe(214);
    expect(calls?.every((n) => !n.fold && n.children.length === 1)).toBe(true);
  });
});

describe("waterfallRows", () => {
  const roots = spanTree(big);

  test("guides follow the ancestors that have siblings below, and the last child ends its elbow", () => {
    const rows = waterfallRows(roots, UNFOCUSED);
    const update = rows.find((r) => r.node.name === "UPDATE invoices");
    const rates = rows.find((r) => r.node.name === "GET /rates");

    expect(rows).toHaveLength(8);
    expect([update?.depth, update?.guides, update?.last]).toEqual([2, [true], true]);
    // Its parent (the calls) is followed by UPDATE, so that line continues past it.
    expect([rates?.depth, rates?.guides, rates?.last]).toEqual([3, [true, true], true]);
  });

  test("a collapsed node hides its descendants; Collapse all leaves the roots", () => {
    const recalculate = roots[0]?.children[1]?.key ?? "";

    expect(
      waterfallRows(roots, { collapsed: new Set([recalculate]), focus: null }).map(
        (r) => r.node.name
      )
    ).toEqual([
      "POST /invoices/overdue",
      "auth.verifySession",
      "invoices.recalculateOverdue",
      "res.json",
    ]);
    expect(waterfallRows(roots, { collapsed: parentKeys(roots), focus: null })).toHaveLength(1);
  });

  test("Errors only keeps the error spans and the path to them, as context", () => {
    const rows = waterfallRows(spanTree(failing), {
      collapsed: parentKeys(spanTree(failing)),
      focus: focusOf({ ...NO_FOCUS, errorsOnly: true }),
    });

    expect(rows.map((r) => [r.node.name, r.context])).toEqual([
      ["test overdue-totals", false],
      ["POST /invoices/overdue", true],
      ["POST /invoices/overdue", true],
      ["invoices.recalculateOverdue", true],
      ["GET fx-rates.internal/rates", false],
    ]);
  });

  test("Find spans matches names, services and id prefixes; one service shows only its spans", () => {
    const shown = (find: string, service: string | null = null) =>
      waterfallRows(roots, { collapsed: new Set(), focus: focusOf({ ...NO_FOCUS, find, service }) })
        .filter((r) => !r.context)
        .map((r) => r.node.name);

    expect(shown("update")).toEqual(["UPDATE invoices"]);
    expect(shown("a91f5d")).toEqual(["UPDATE invoices"]);
    expect(shown("", "fx-rates")).toEqual(["GET /rates"]);
  });
});

describe("tableRows", () => {
  test("lists every node flat, longest first (Paper T6's order; the fixture's auth is 6 ms)", () => {
    expect(names(tableRows(spanTree(big)))).toEqual([
      "POST /invoices/overdue",
      "invoices.recalculateOverdue",
      "GET fx-rates.internal/rates ×214",
      "GET /rates ×214",
      "UPDATE invoices",
      "SELECT invoices",
      "res.json",
      "auth.verifySession",
    ]);
  });

  test("sorting by status puts error spans first", () => {
    const rows = tableRows(spanTree(failing), { key: "status", descending: false });

    expect(rows.slice(0, 2).map((n) => [n.name, n.error])).toEqual([
      ["test overdue-totals", true],
      ["GET fx-rates.internal/rates", true],
    ]);
  });
});
