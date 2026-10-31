/**
 * A 10,000-span trace across 30 services for measuring the service map (`#traces/mesh`): a
 * gateway fans each batch out through three layers of services, with cross calls, redis and
 * postgresql behind them, until the trace holds exactly MESH_SPANS spans.
 */
import type { TraceTurn } from "@polaris/protocol";
import type { SpanSpec, TraceSpec } from "./build.ts";

export const MESH_SPANS = 10_000;

export const MESH_TRACE_ID = "b1e55ed0c0ffee004d3a5b7c9e1f3a5b";

const SERVICES = [
  "gateway",
  "accounts",
  "catalog",
  "checkout",
  "search",
  "reports",
  "auth",
  "sessions",
  "inventory",
  "pricing",
  "cart",
  "payments",
  "reviews",
  "recommendations",
  "ledger",
  "invoices",
  "users",
  "profiles",
  "tax",
  "currency",
  "fx-rates",
  "fraud",
  "refunds",
  "shipping",
  "loyalty",
  "email",
  "notifications",
  "webhooks",
  "billing",
  "orders",
] as const;

/** Layers 1–3: five under the gateway, ten under those, fourteen under those. */
const parentOf = (j: number) => {
  if (j <= 5) return 0;

  return j <= 15 ? 1 + ((j - 6) >> 1) : 6 + ((j - 16) % 10);
};

const callees = SERVICES.map((_, i) => {
  const tree = SERVICES.flatMap((_, j) => (j > 0 && parentOf(j) === i ? [j] : []));
  const cross = (i * 7) % 29;

  return cross > i && !tree.includes(cross) ? [...tree, cross] : tree;
});

const hex = (n: number) => `b1${n.toString(16).padStart(14, "0")}`;

interface Frame {
  readonly service: number;
  readonly parent: string;
  readonly at: number;
}

/** One batch: every service the gateway reaches, each call a client span with a server span under it. */
const batch = (b: number, parent: string, next: () => string): ReadonlyArray<SpanSpec> => {
  const spans: Array<SpanSpec> = [];
  const stack: Array<Frame> = [{ service: 0, parent, at: 20 + b * 40 }];

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const name = SERVICES[frame.service] ?? "gateway";

    callees[frame.service]?.forEach((c, k) => {
      const callee = SERVICES[c] ?? "gateway";
      const client = next();
      const server = next();
      const at = frame.at + 0.2 + k * 0.6;

      spans.push(
        {
          id: client,
          parent: frame.parent,
          name: `GET ${callee}.internal/v1`,
          service: name,
          kind: "client",
          at,
          ms: 0.5,
          attributes: { "http.request.method": "GET", "url.full": `http://${callee}.internal/v1` },
        },
        {
          id: server,
          parent: client,
          name: "GET /v1",
          service: callee,
          kind: "server",
          at: at + 0.02,
          ms: 0.45,
          status: b % 9 === 4 && c === 21 ? "error" : "unset",
        }
      );
      stack.push({ service: c, parent: server, at: at + 0.04 });
    });

    if (frame.service >= 16)
      spans.push({
        id: next(),
        parent: frame.parent,
        name: "SELECT rows",
        service: name,
        kind: "client",
        at: frame.at + 0.1,
        ms: 0.1,
        attributes: { "db.system.name": "postgresql", "db.query.text": "select 1" },
      });
    else if (frame.service >= 6)
      spans.push({
        id: next(),
        parent: frame.parent,
        name: "GET cache",
        service: name,
        kind: "client",
        at: frame.at + 0.1,
        ms: 0.05,
        attributes: { "db.system.name": "redis" },
      });
  }

  return spans;
};

export const meshTrace = (turn: TraceTurn): TraceSpec => {
  let n = 0;
  const next = () => hex(++n);
  const root = next();
  const spans: Array<SpanSpec> = [];

  for (let b = 0; spans.length < MESH_SPANS - 1; b++) spans.push(...batch(b, root, next));
  const kept = spans.slice(0, MESH_SPANS - 1);
  const end = Math.max(...kept.map((s) => s.at + s.ms));

  return {
    id: MESH_TRACE_ID,
    startedAt: "2026-10-31T14:02:50.000Z",
    turn,
    launchedTurn: null,
    spans: [
      {
        id: root,
        parent: null,
        name: "POST /graph/rebuild",
        service: "gateway",
        kind: "server",
        at: 0,
        ms: end + 5,
        attributes: { "http.request.method": "POST", "http.route": "/graph/rebuild" },
      },
      ...kept,
    ],
  };
};
