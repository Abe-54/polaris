import "../../../../test/dom.testing.ts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import {
  spanTree,
  traceTimes,
  type WaterfallRow,
  waterfallRows,
} from "../../model/waterfall/index.ts";
import { BIG_TRACE, ERROR_TRACE, FIXTURE_DETAILS } from "../../preview/fixtures.ts";
import { nudged } from "./Minimap.tsx";
import { SpanRow } from "./SpanRow.tsx";

afterEach(cleanup);

const rowsOf = (id: string, expanded: ReadonlySet<string> = new Set()) => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === id)!;

  return waterfallRows(spanTree(traceTimes(detail), expanded), {
    collapsed: new Set(),
    focus: null,
  });
};

const mount = (row: WaterfallRow) =>
  render(
    <SpanRow
      id="row"
      row={row}
      hue="var(--pv-series-1)"
      selected={false}
      collapsed={false}
      range={{ from: 0, to: 2000 }}
      dim={false}
      actions={{ onSelect: () => {}, onCollapse: () => {}, onFold: () => {} }}
    />
  );

test("finding 14: an error row says error in words, not only in red", () => {
  const rows = rowsOf(ERROR_TRACE.id);
  const failed = rows.find((r) => r.node.error)!;
  const fine = rows.find((r) => !r.node.error)!;

  mount(failed);
  expect(within(screen.getByRole("row")).getByText("error")).not.toBeNull();
  cleanup();
  mount(fine);
  expect(screen.queryByTestId("row-error")).toBeNull();
});

test("finding 19: a long name truncates with its whole name as the title, bidi controls named", () => {
  const [row] = rowsOf(BIG_TRACE.id);
  const name = `GET /invoices/‮exe.overdue/${"x".repeat(200)}`;

  mount({ ...row!, node: { ...row!.node, name } });
  const shown = screen.getByTitle(name);

  expect(shown.className).toContain("truncate");
  expect(shown.textContent).not.toContain("‮");
});

test("finding 19: past twelve levels the indent stops growing and says how deep", () => {
  const [row] = rowsOf(BIG_TRACE.id);

  mount({ ...row!, depth: 20, guides: Array.from({ length: 20 }, () => true) });
  expect(screen.getByTitle("8 more levels deep").textContent).toBe("+8");
});

test("finding 17: the count and ×n badges stay out of the tab order", () => {
  const rows = rowsOf(BIG_TRACE.id);
  const badges = rows.filter((r) => r.node.fold || r.node.children.length > 0).slice(0, 3);

  for (const row of badges) {
    mount(row);

    for (const button of screen.getAllByRole("button")) expect(button.tabIndex).toBe(-1);
    cleanup();
  }

  expect(badges.length).toBeGreaterThan(1);
});

test("finding 17: arrows pan the minimap's window by a tenth; with Shift they move its end", () => {
  const range = { from: 100, to: 300 };

  expect(nudged(range, 1000, "ArrowRight", false)).toEqual({ from: 200, to: 400 });
  expect(nudged(range, 1000, "ArrowLeft", false)).toEqual({ from: 0, to: 200 });
  expect(nudged({ from: 0, to: 200 }, 1000, "ArrowLeft", false)).toEqual({ from: 0, to: 200 });
  expect(nudged(range, 1000, "ArrowRight", true)).toEqual({ from: 100, to: 400 });
  expect(nudged(range, 1000, "ArrowLeft", true)).toEqual({ from: 100, to: 200 });
  expect(nudged(range, 1000, "Enter", false)).toBeNull();
});
