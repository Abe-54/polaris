/** Where the map draws and opens (RPU's P6 findings, ENG-666). */
import { expect, test } from "bun:test";
import { FIXTURE_DETAILS } from "../../preview/fixtures.ts";
import { SETTLE_TRACE_ID } from "../../preview/settle.ts";
import { traceTimes } from "../waterfall/index.ts";
import { LABEL_ABOVE, MARGIN, mapLayout, openView, revealView, serviceMap } from "./index.ts";
import { mapOfSpans, spanAt as at } from "./spans.testing.ts";

const settle = () => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === SETTLE_TRACE_ID);

  if (detail === undefined) throw new Error("no settle fixture");

  return mapLayout(serviceMap(traceTimes(detail)));
};

/** The services whose art and label box end below the top of the foot at the opening view. */
const underFoot = (canvas: { width: number; height: number }) => {
  const layout = settle();
  const view = openView(canvas, layout);
  const visible = canvas.height - MARGIN.foot;

  return layout.placed
    .filter((p) => view.y + (p.base + 4) * view.k > visible)
    .map((p) => p.node.name);
};

test("finding P6-1: the settlement map opens with every row above the foot", () => {
  // Width alone would allow OPEN_ZOOM here; height doesn't.
  expect(underFoot({ width: 780, height: 680 })).toEqual([]);
  expect(underFoot({ width: 780, height: 720 })).toEqual([]);
  expect(underFoot({ width: 1100, height: 760 })).toEqual([]);
});

test("finding P6-4: a call back up a cycle neither retraces the call down nor labels over the callee", () => {
  const layout = mapLayout(
    mapOfSpans([
      at(1, null, "gateway", "server"),
      at(2, 1, "gateway", "client"),
      at(3, 2, "billing", "server"),
      at(4, 3, "billing", "client"),
      at(5, 4, "gateway", "server"),
    ])
  );

  const down = layout.routes.find((r) => r.edge.from === "gateway");
  const back = layout.routes.find((r) => r.edge.from === "billing");
  const billing = layout.placed.find((p) => p.node.name === "billing");

  if (down === undefined || back === undefined || billing === undefined)
    throw new Error("missing route or node");
  const verticals = (path: string) => [...path.matchAll(/H(-?[\d.]+)V/g)].map((m) => m[1]);
  const top = billing.base - LABEL_ABOVE - 4;

  const inBillingLabel =
    Math.abs(back.label.x - billing.x) < 106 && back.label.y > top && back.label.y < billing.base;

  expect(verticals(back.path)).not.toEqual(verticals(down.path));
  expect(inBillingLabel).toBe(false);
  // Its label stays inside the map, so fitting shows it.
  expect(back.label.x).toBeLessThan(layout.width);
});

test("finding P6-12: focusing a node below the foot pans it into view, and one in view stays put", () => {
  const canvas = { width: 800, height: 600 };
  const view = { x: 0, y: 0, k: 1 };
  const low = { x: 100, y: 580, width: 212, height: 134 };

  const shown = revealView(view, canvas, low);

  expect(shown.y + low.y + low.height).toBe(canvas.height - MARGIN.foot);
  expect(shown.x).toBe(view.x);
  expect(revealView(view, canvas, { ...low, y: 100 })).toEqual(view);
});
