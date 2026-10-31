/**
 * P6 repros on the service map's pure model (graph, layout, viewport). Each test names a finding
 * in the P6 report, fails on 99ca0343d and should pass once that finding is fixed.
 */
import { expect, test } from "bun:test";
import type { Span, TraceAttributes } from "../../../../packages/protocol/src/index.ts";
import {
  LABEL_ABOVE,
  MARGIN,
  mapLayout,
  openView,
  serviceMap,
  servicePanel,
} from "../../../../apps/desktop/src/renderer/features/traces/model/map/index.ts";
import { traceTimes } from "../../../../apps/desktop/src/renderer/features/traces/model/waterfall/index.ts";
import {
  buildTrace,
  type SpanSpec,
} from "../../../../apps/desktop/src/renderer/features/traces/preview/build.ts";
import {
  FIXTURE_CHECKOUT,
  FIXTURE_DETAILS,
} from "../../../../apps/desktop/src/renderer/features/traces/preview/fixtures.ts";
import { SETTLE_TRACE_ID } from "../../../../apps/desktop/src/renderer/features/traces/preview/settle.ts";

const mapOf = (spans: ReadonlyArray<SpanSpec>) =>
  serviceMap(
    traceTimes(
      buildTrace(
        {
          id: "0123456789abcdef0123456789abcdef",
          startedAt: "2026-10-31T14:00:00.000Z",
          turn: null,
          launchedTurn: null,
          spans,
        },
        FIXTURE_CHECKOUT
      )
    )
  );

const id = (n: number) => n.toString(16).padStart(16, "0");

const at = (
  n: number,
  parent: number | null,
  service: string,
  kind: Span["kind"],
  attributes: TraceAttributes = {}
): SpanSpec => ({
  id: id(n),
  parent: parent === null ? null : id(parent),
  name: `${kind} ${n}`,
  service,
  kind,
  at: n,
  ms: 100 - n,
  attributes,
});

const edges = (map: ReturnType<typeof serviceMap>) =>
  map.edges.map((e) => `${e.from} → ${e.to} ×${e.calls}`).toSorted();

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
  // The map is 880×882: width fits at 0.83×, height at 0.69×, so openView falls back to 0.8×.
  expect(underFoot({ width: 780, height: 680 })).toEqual([]);
  // At 0.8× from the top the bottom row ends at 685px, so any canvas under 737px clips it.
  expect(underFoot({ width: 780, height: 720 })).toEqual([]);
});

test("finding P6-2: a service named api calling api.stripe.com draws the call", () => {
  const own = mapOf([
    at(1, null, "api", "server"),
    at(2, 1, "api", "client", { "url.full": "https://api.stripe.com/v1/charges" }),
  ]);

  const other = mapOf([
    at(1, null, "web", "server"),
    at(2, 1, "web", "client", { "url.full": "https://api.stripe.com/v1/charges" }),
    at(3, 1, "web", "client", { "url.full": "http://api.internal/users" }),
    at(4, 3, "api", "server"),
  ]);

  expect(edges(own)).toEqual(["api → api.stripe.com ×1"]);
  expect(edges(other)).toEqual(["web → api ×1", "web → api.stripe.com ×1"]);
});

test("finding P6-3: one HTTP call through two nested client spans is one call, no phantom host", () => {
  const nested = (url: string) =>
    mapOf([
      at(1, null, "ledger-api", "server"),
      at(2, 1, "ledger-api", "client", { "url.full": url }),
      at(3, 2, "ledger-api", "client", { "url.full": url }),
      at(4, 3, "fx-rates", "server"),
    ]);

  const http = nested("http://10.0.4.12:8080/rates");

  const orm = mapOf([
    at(1, null, "ledger-api", "server"),
    at(2, 1, "ledger-api", "client", { "db.system.name": "postgresql" }),
    at(3, 2, "ledger-api", "client", { "db.system.name": "postgresql" }),
  ]);

  expect(edges(nested("http://fx-rates.internal/rates"))).toEqual(["ledger-api → fx-rates ×1"]);
  expect(edges(http)).toEqual(["ledger-api → fx-rates ×1"]);
  expect(http.nodes.map((n) => n.name)).toEqual(["ledger-api", "fx-rates"]);
  expect(edges(orm)).toEqual(["ledger-api → postgresql ×1"]);
});

test("finding P6-4: a call back up a cycle neither retraces the call down nor labels over the callee", () => {
  const layout = mapLayout(
    mapOf([
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
});

test("finding P6-5: twelve tests that each call the API once are not an N+1 in one request", () => {
  const tests = Array.from({ length: 12 }, (_, i) => [
    at(10 + i * 3, 1, "ledger-tests", "internal"),
    at(11 + i * 3, 10 + i * 3, "ledger-tests", "client", { "http.request.method": "GET" }),
    at(12 + i * 3, 11 + i * 3, "ledger-api", "server"),
  ]).flat();

  const map = mapOf([at(1, null, "ledger-tests", "internal"), ...tests]);
  const panel = servicePanel(map, "ledger-tests");

  expect(panel?.calls.map((c) => [c.name, c.calls])).toEqual([["ledger-api", 12]]);
  expect(panel?.nPlusOne).toEqual([]);
});
