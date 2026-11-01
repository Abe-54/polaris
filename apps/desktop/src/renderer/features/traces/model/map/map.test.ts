import { describe, expect, test } from "bun:test";
import type { TraceAttributes } from "@polaris/protocol";
import { buildTrace, type TraceSpec } from "../../preview/build.ts";
import {
  BIG_TRACE,
  ERROR_TRACE,
  FIXTURE_CHECKOUT,
  FIXTURE_DETAILS,
  FIXTURE_TURNS,
} from "../../preview/fixtures.ts";
import { MESH_SPANS, meshTrace } from "../../preview/mesh.ts";
import { SETTLE_TRACE_ID } from "../../preview/settle.ts";
import { traceTimes } from "../waterfall/index.ts";
import {
  callerWords,
  edgeWords,
  fitView,
  inferTarget,
  type MapEdge,
  mapLayout,
  matchService,
  MAX_ZOOM,
  MIN_ZOOM,
  nodeWords,
  OPEN_ZOOM,
  openView,
  type ServiceMap,
  serviceMap,
  servicePanel,
  SLOT,
  type Target,
  wheelFactor,
  zoomAt,
} from "./index.ts";

const mapOf = (id: string) => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === id);

  if (detail === undefined) throw new Error(`no fixture trace ${id}`);

  return serviceMap(traceTimes(detail));
};

const edgeLine = (e: MapEdge) =>
  `${e.from} → ${e.to} ${edgeWords(e)}${e.errors > 0 ? ` (${e.errors} failed)` : ""}`;

const nodeLine = (map: ServiceMap) =>
  map.nodes.map((n) => [n.name, n.kind, n.spans, n.requests.length, Math.round(n.requestMs)]);

describe("the overdue run's map", () => {
  const map = mapOf(BIG_TRACE.id);

  test("ledger-api calls fx-rates 214 times over HTTP and an inferred postgresql twice", () => {
    expect(nodeLine(map)).toEqual([
      ["ledger-api", "service", 220, 1, 840],
      ["fx-rates", "service", 214, 214, 636],
      ["postgresql", "database", 2, 2, 154],
    ]);
    expect(map.edges.map(edgeLine)).toEqual([
      "ledger-api → postgresql ×2 · SQL",
      "ledger-api → fx-rates ×214 · HTTP",
    ]);
  });

  test("a request from outside the trace has no command; it ran during its Turn", () => {
    expect(callerWords(map.caller)).toEqual(["during turn 12"]);
    expect([...map.caller.roots]).toEqual([["ledger-api", 1]]);
  });

  test("ledger-api's panel: calls by total, the N+1 named, started by the Turn", () => {
    const panel = servicePanel(map, "ledger-api");

    expect(
      panel?.calls.map((c) => [c.name, c.calls, Math.round(c.ms), c.nPlusOne, c.share])
    ).toEqual([
      ["fx-rates", 214, 640, true, 1],
      ["postgresql", 2, 154, false, 154 / 639.808],
    ]);
    expect(panel?.nPlusOne).toEqual([
      "214 calls to fx-rates in one request: 3 ms each, 640 ms in all.",
    ]);
    expect(panel?.startedBy?.spans).toBe(1);
    expect(panel?.slowest.map((s) => s.span.name)).toEqual(["POST /invoices/overdue"]);
  });

  test("fx-rates is called by ledger-api and lists its five slowest requests", () => {
    const panel = servicePanel(map, "fx-rates");

    expect(panel?.calledBy.map((c) => [c.name, c.calls])).toEqual([["ledger-api", 214]]);
    expect(panel?.startedBy).toBeNull();
    expect(panel?.slowest).toHaveLength(5);
  });
});

test("Turn 11's twelve lookups are an N+1, under ten wouldn't be", () => {
  const run = FIXTURE_DETAILS.find((d) => d.summary.id === "5d0a1c6f8e2b4a97b6c8e0f2a4d63e5f");

  if (run === undefined) throw new Error("no Turn 11 run");
  const twelve = servicePanel(serviceMap(traceTimes(run)), "ledger-api");

  const nine = servicePanel(
    serviceMap(
      traceTimes({
        ...run,
        spans: run.spans.filter((s) => !/^(c1|d2)0*([9ab])$/.test(s.id)),
      })
    ),
    "ledger-api"
  );

  expect(twelve?.nPlusOne).toEqual([
    "12 calls to fx-rates in one request: 2.5 ms each, 30 ms in all.",
  ]);
  expect(nine?.calls.find((c) => c.name === "fx-rates")?.calls).toBe(9);
  expect(nine?.nPlusOne).toEqual([]);
});

describe("the settlement run's map", () => {
  const map = mapOf(SETTLE_TRACE_ID);

  test("five services, and the dependencies their client spans name", () => {
    expect(
      map.nodes.map(
        (n) =>
          `${n.name} ${nodeWords(
            n,
            map.edges.filter((e) => e.to === n.name)
          ).join(" · ")}`
      )
    ).toEqual([
      "settle-job service · 2 spans",
      "ledger-api service · 8 spans",
      "fx-rates service · 6 spans",
      "audit-log service · 2 spans",
      "notifier service · 13 spans",
      "postgresql inferred · database",
      "redis inferred · database",
      "api.postmarkapp.com inferred · HTTP",
    ]);
    expect(map.edges.map(edgeLine).toSorted()).toEqual([
      "audit-log → postgresql ×1 · SQL",
      "fx-rates → redis ×3 · REDIS",
      "ledger-api → audit-log ×1 · HTTP",
      "ledger-api → fx-rates ×3 · HTTP",
      "ledger-api → notifier ×1 · KAFKA",
      "ledger-api → postgresql ×2 · SQL",
      "notifier → api.postmarkapp.com ×12 · HTTP (1 failed)",
      "settle-job → ledger-api ×1 · HTTP",
    ]);
  });

  test("the script's command and Turn are the caller", () => {
    expect(callerWords(map.caller)).toEqual(["bun run settle.ts", "during turn 11"]);
    expect(servicePanel(map, "settle-job")?.startedBy?.command).toBe(
      "bun run scripts/settle.ts --month 2026-10"
    );
  });

  test("a consumer's request is the message it processed, so its 12 emails are one N+1", () => {
    const notifier = servicePanel(map, "notifier");

    expect(notifier?.node.requests.map((s) => s.span.name)).toEqual([
      "settlements.created process",
    ]);
    expect(notifier?.node.errors).toBe(1);
    expect(notifier?.nPlusOne).toEqual([
      "12 calls to api.postmarkapp.com in one request: 65 ms each, 778 ms in all.",
    ]);
  });

  test("layers follow distance from the caller; a callee of two layers sits under the nearer", () => {
    const layout = mapLayout(map);
    const layers = Object.fromEntries(layout.placed.map((p) => [p.node.name, p.layer]));

    expect(layers).toEqual({
      "settle-job": 0,
      "ledger-api": 1,
      "fx-rates": 2,
      postgresql: 2,
      notifier: 2,
      "audit-log": 2,
      redis: 3,
      "api.postmarkapp.com": 3,
    });

    for (const row of Map.groupBy(layout.placed, (p) => p.layer).values()) {
      const xs = row.map((p) => p.x).toSorted((a, b) => a - b);

      expect(xs.slice(1).map((x, i) => x - (xs[i] ?? 0))).toEqual(xs.slice(1).map(() => SLOT));
    }
  });

  test("two connectors into postgresql arrive apart, the one from below turning back up", () => {
    const layout = mapLayout(map);
    const into = layout.routes.filter((r) => r.edge.to === "postgresql");
    const pg = layout.placed.find((p) => p.node.name === "postgresql");

    expect(new Set(into.map((r) => r.light.x)).size).toBe(2);
    expect(
      into.find((r) => r.edge.from === "audit-log")?.path.endsWith(`V${(pg?.base ?? 0) + 6}`)
    ).toBe(true);
  });
});

describe("the failing test's map", () => {
  const map = mapOf(ERROR_TRACE.id);

  test("a timed-out call nothing answered is an inferred host with its failure", () => {
    expect(map.edges.map(edgeLine).toSorted()).toEqual([
      "ledger-api → fx-rates.internal ×1 · HTTP (1 failed)",
      "ledger-api → postgresql ×1 · SQL",
      "ledger-tests → ledger-api ×1 · HTTP",
    ]);
    expect(callerWords(map.caller)).toEqual(["bun test overdue-totals", "during turn 12"]);
  });
});

describe("inferTarget", () => {
  test.each<[TraceAttributes, Target | null]>([
    [{ "db.system": "mysql" }, { name: "mysql", kind: "database", protocol: "SQL" }],
    [{ "db.system.name": "mongodb" }, { name: "mongodb", kind: "database", protocol: "MONGODB" }],
    [
      { "messaging.system": "rabbitmq", "messaging.destination.name": "orders" },
      { name: "orders", kind: "remote", protocol: "RABBITMQ" },
    ],
    [
      { "rpc.system": "grpc", "rpc.service": "billing.Invoices" },
      { name: "billing.Invoices", kind: "remote", protocol: "GRPC" },
    ],
    [
      { "http.request.method": "GET", "url.full": "https://api.stripe.com/v1/charges" },
      { name: "api.stripe.com", kind: "remote", protocol: "HTTP" },
    ],
    [{ "server.address": "10.0.4.12" }, { name: "10.0.4.12", kind: "remote", protocol: null }],
    [{ "url.full": "not a url" }, null],
    [{ "code.function.name": "save" }, null],
  ])("%j", (attributes, target) => {
    expect(inferTarget(attributes)).toEqual(target);
  });

  test("a host names a traced service by itself, or its first label under a private suffix", () => {
    const services = new Set(["fx-rates", "api"]);

    expect(
      [
        "fx-rates",
        "fx-rates.internal",
        "fx-rates.ledger.svc.cluster.local",
        "api.local",
        "fx.internal",
        "api.stripe.com",
        "api.v1.Users",
        "rates",
      ].map((n) => matchService(n, services))
    ).toEqual(["fx-rates", "fx-rates", "fx-rates", "api", null, null, null, null]);
  });
});

test("a client span naming its own service isn't a call", () => {
  const spec: TraceSpec = {
    id: "0123456789abcdef0123456789abcdef",
    startedAt: "2026-10-31T14:00:00.000Z",
    turn: null,
    launchedTurn: null,
    spans: [
      {
        id: "aaaaaaaaaaaaaaa1",
        parent: null,
        name: "GET /",
        service: "web",
        kind: "server",
        at: 0,
        ms: 10,
      },
      {
        id: "aaaaaaaaaaaaaaa2",
        parent: "aaaaaaaaaaaaaaa1",
        name: "GET web.internal/health",
        service: "web",
        kind: "client",
        at: 1,
        ms: 2,
        attributes: { "url.full": "http://web.internal/health" },
      },
    ],
  };

  const map = serviceMap(traceTimes(buildTrace(spec, FIXTURE_CHECKOUT)));

  expect([map.nodes.length, map.edges.length]).toEqual([1, 0]);
  expect(callerWords(map.caller)).toEqual(["between turns"]);
});

test("the 10,000-span mesh maps 30 services and the two stores behind them", () => {
  const detail = buildTrace(meshTrace(FIXTURE_TURNS[12]), FIXTURE_CHECKOUT);
  const map = serviceMap(traceTimes(detail));
  const layout = mapLayout(map);

  expect(detail.spans).toHaveLength(MESH_SPANS);
  expect(map.nodes.filter((n) => n.kind === "service")).toHaveLength(30);
  expect(
    map.nodes
      .filter((n) => n.kind === "database")
      .map((n) => n.name)
      .toSorted()
  ).toEqual(["postgresql", "redis"]);
  expect(layout.routes).toHaveLength(map.edges.length);
});

describe("the viewport", () => {
  test("fit centres the map in the canvas less its margins, never enlarging it", () => {
    expect(fitView({ width: 800, height: 600 }, { width: 376, height: 262 })).toEqual({
      x: 212,
      y: 24 + (524 - 262) / 2,
      k: 1,
    });
    const wide = fitView({ width: 800, height: 600 }, { width: 1504, height: 400 });

    expect(wide.k).toBe(0.5);
    expect(wide.x).toBe(24);
  });

  test("a map too wide to read whole opens at OPEN_ZOOM from the top, centred across", () => {
    const canvas = { width: 800, height: 600 };
    const small = { width: 376, height: 262 };

    expect(openView(canvas, small)).toEqual(fitView(canvas, small));
    expect(openView(canvas, { width: 3000, height: 900 })).toEqual({
      x: (800 - 3000 * OPEN_ZOOM) / 2,
      y: 24,
      k: OPEN_ZOOM,
    });
  });

  test("a map too big for the smallest zoom stays at it", () => {
    expect(fitView({ width: 300, height: 200 }, { width: 30_000, height: 9000 }).k).toBe(MIN_ZOOM);
  });

  test("zooming keeps the point under the cursor where it was, within the limits", () => {
    const view = { x: 100, y: 50, k: 1 };
    const at = { x: 300, y: 250 };
    const near = zoomAt(view, 2, at);
    const mapPoint = (v: typeof view) => ({ x: (at.x - v.x) / v.k, y: (at.y - v.y) / v.k });

    expect(mapPoint(near)).toEqual(mapPoint(view));
    expect(zoomAt(near, 100, at).k).toBe(MAX_ZOOM);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
  });
});
