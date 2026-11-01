/**
 * Review's Traces section on fixtures (ENG-660): `#review/session-traces` (Route timings open),
 * `-list` (the files list only), `-new` (no route ran in the earlier Turn), `-worst` (14 routes,
 * long names, every unit), `-failed`, `-unsupported` (no `traces.compare`), and
 * `session-data-traces` (beside the Data section).
 */
import {
  TRACES_COMPARE_CAPABILITY,
  TraceCompareSelector,
  type TraceComparison,
  type TraceRouteStats,
  TurnId,
} from "@polaris/protocol";
import type { HostView, Result } from "../../../../shared/api.ts";

export const isTracesScene = (scene: string) =>
  scene.startsWith("session-traces") || scene === "session-data-traces";

/** The scenes that open with Route timings in the diff pane. */
export const opensTraces = (scene: string) =>
  isTracesScene(scene) && scene !== "session-traces-list" && scene !== "session-data-traces";

/** `-unsupported`: the local Host as an older Daemon without `traces.compare`. */
export const tracesHosts = (scene: string, hosts: ReadonlyArray<HostView>) =>
  scene === "session-traces-unsupported"
    ? hosts.map((h) =>
        h.key === "local"
          ? {
              ...h,
              status: {
                ...h.status,
                capabilities: h.status.capabilities.filter((c) => c !== TRACES_COMPARE_CAPABILITY),
              },
            }
          : h
      )
    : hosts;

const runs = (p50Ms: number | null, count: number): TraceRouteStats => ({
  p50Ms,
  p95Ms: p50Ms === null ? null : Math.round(p50Ms * 1.6),
  count,
});

const NONE = runs(null, 0);

type Route = readonly [
  service: string,
  route: string,
  before: TraceRouteStats,
  after: TraceRouteStats,
];

const ROUTES: ReadonlyArray<Route> = [
  ["fx-rates", "GET /rates/:currency", runs(18, 6), runs(19, 7)],
  ["ledger-api", "GET /customers/:id", NONE, runs(38, 3)],
  ["ledger-api", "GET /invoices", runs(96, 4), runs(41, 4)],
  ["ledger-api", "POST /invoices/overdue", runs(122, 5), runs(840, 5)],
  ["ledger-api", "POST /invoices/import", runs(1920, 1), NONE],
  ["ledger-tests", "test overdue-totals", runs(1400, 2), runs(3100, 3)],
];

const WORST: ReadonlyArray<Route> = [
  ...ROUTES,
  [
    "billing-reconciliation-worker",
    "POST /internal/reconciliation/batches/:batchId/settlements/recompute",
    runs(2.4, 214),
    runs(9.8, 214),
  ],
  [
    "ledger-api",
    "GET /customers/:customerId/invoices?status=overdue&include=payments,adjustments",
    runs(310, 12),
    runs(298, 12),
  ],
  ["ledger-api", "DELETE /invoices/:id", NONE, runs(7.2, 1)],
  ["ledger-api", "PATCH /invoices/:id", runs(64, 2), runs(61, 2)],
  ["ledger-jobs", "job nightly-aging-report", runs(84_000, 1), runs(151_000, 1)],
  ["ledger-api", "GET /health", runs(1.1, 1200), runs(1.2, 1311)],
  ["ledger-tests", "test invoices import csv with 10k rows", runs(12_400, 1), runs(11_900, 1)],
  ["ledger-api", "POST /payments/webhook", runs(23, 40), NONE],
];

const routesFor = (scene: string): ReadonlyArray<Route> => {
  if (scene === "session-traces-worst") return WORST;

  if (scene === "session-traces-new") return ROUTES.map(([s, r, , after]) => [s, r, NONE, after]);

  return ROUTES;
};

/** The Daemon's rule: under three runs on either side, both sides lose their percentiles. */
const daemonSides = (before: TraceRouteStats, after: TraceRouteStats) =>
  before.count >= 3 && after.count >= 3
    ? { before, after }
    : { before: runs(null, before.count), after: runs(null, after.count) };

const turn = (id: string) => TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make(id) });

/** What the Daemon would answer for the scene; the Daemon's service-then-route order. */
export const tracesCompareAnswer = (
  scene: string,
  input: { readonly a?: TraceCompareSelector; readonly b?: TraceCompareSelector }
): Promise<Result<TraceComparison>> => {
  if (scene === "session-traces-failed")
    return Promise.resolve({
      ok: false,
      error: {
        code: "E-TRACE-UNAVAILABLE",
        message: "Reading this checkout’s traces timed out",
        fix: "Open Review again",
      },
    });

  const routes = routesFor(scene)
    .map(([service, route, before, after]) => ({
      service,
      route,
      ...daemonSides(before, after),
    }))
    .toSorted((x, y) =>
      x.service === y.service ? x.route.localeCompare(y.route) : x.service.localeCompare(y.service)
    );

  return Promise.resolve({
    ok: true,
    value: { a: input.a ?? turn("t21"), b: input.b ?? turn("t23"), routes },
  });
};
