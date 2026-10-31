import "../../../../test/dom.testing.ts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { spanTree, traceTimes, waterfallRows } from "../../model/waterfall/index.ts";
import { BIG_TRACE, FIXTURE_DETAILS } from "../../preview/fixtures.ts";
import { SpanRow } from "./SpanRow.tsx";

afterEach(cleanup);

const detail = FIXTURE_DETAILS.find((d) => d.summary.id === BIG_TRACE.id)!;

const rows = waterfallRows(spanTree(traceTimes(detail), new Set()), {
  collapsed: new Set(),
  focus: null,
});

const mount = (name: string, usual = detail.usual) => {
  const row = rows.find((r) => r.node.name === name)!;

  render(
    <SpanRow
      row={row}
      usual={usual}
      hue="var(--pv-series-1)"
      selected={false}
      collapsed={false}
      range={{ from: 0, to: 840 }}
      dim={false}
      actions={{ onSelect: () => {}, onCollapse: () => {}, onFold: () => {} }}
    />
  );
};

test.each([
  ["UPDATE invoices", "SLOW"],
  ["auth.verifySession", "FAST"],
])("the lane compares %s to its usual duration: %s", (name, verdict) => {
  mount(name);
  expect(screen.getByTestId("duration-verdict").textContent).toBe(verdict);
  expect(screen.getByTestId("duration-verdict").title).toContain("in this checkout");
});

test("the reserved lane stays empty without a baseline", () => {
  mount("UPDATE invoices", {});
  expect(screen.queryByTestId("duration-verdict")).toBeNull();
});

test("a folded sum is not compared against a single call's usual duration", () => {
  mount(
    "GET fx-rates.internal/rates",
    Object.fromEntries(detail.spans.map((s) => [s.id, { usualMs: 1, samples: 10 }]))
  );
  expect(screen.queryByTestId("duration-verdict")).toBeNull();
});
