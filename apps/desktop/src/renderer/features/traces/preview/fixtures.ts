/**
 * The ledger checkout's traces for "Fix overdue totals" (Paper "Traces (⌘5)", T1–T6): Turns 10–12
 * and between Turns; the 434-span overdue run across ledger-api and fx-rates with ×214 repeated
 * calls, a failing test with an exception and logs, a partial trace, and the receiver's states.
 */
import {
  type LogRecord,
  SessionId,
  type TraceDetail,
  TraceAvailability,
  type TracesSnapshot,
  type TraceTurn,
  TurnId,
  WorkspaceId,
} from "@polaris/protocol";
import {
  buildLog,
  buildTrace,
  type Checkout,
  type LogSpec,
  type SpanSpec,
  type TraceSpec,
} from "./build.ts";

export const FIXTURE_SESSION = SessionId.make("s-overdue-totals");

export const FIXTURE_CHECKOUT: Checkout = {
  checkout: "/Users/lucas/code/ledger.worktrees/overdue-totals",
  workspaceId: WorkspaceId.make("ledger"),
  sessionId: FIXTURE_SESSION,
};

const turn = (number: number): TraceTurn => ({
  sessionId: FIXTURE_SESSION,
  id: TurnId.make(`t-overdue-${number}`),
  number,
});

export const FIXTURE_TURNS = { 10: turn(10), 11: turn(11), 12: turn(12) } as const;

const db = (query: string, line: number, fn: string) => ({
  "db.system.name": "postgresql",
  "db.namespace": "ledger_overdue",
  "db.query.text": query,
  "server.address": "localhost",
  "server.port": 5432,
  "code.function.name": fn,
  "code.file.path": "src/invoices/overdue.ts",
  "code.line.number": line,
});

const http = (method: string, route: string, status: number) => ({
  "http.request.method": method,
  "http.route": route,
  "url.path": route,
  "http.response.status_code": status,
  "server.address": "localhost",
  "server.port": 3000,
});

const hex = (prefix: string, n: number, width: number) =>
  `${prefix}${n.toString(16).padStart(width - prefix.length, "0")}`;

/**
 * POST /invoices/overdue: a rate lookup per invoice, each a ledger-api client span with an
 * fx-rates server span under it, spread over `window` ms (the N+1 the service map names).
 */
const overdueRun = (repeats: number, window: number, total: number): ReadonlyArray<SpanSpec> => {
  const step = window / repeats;

  const calls = Array.from({ length: repeats }, (_, i): ReadonlyArray<SpanSpec> => {
    const client = hex("c1", i, 16);

    return [
      {
        id: client,
        parent: "b30e4d1a7c2f9e05",
        name: "GET fx-rates.internal/rates",
        service: "ledger-api",
        kind: "client",
        at: 58 + i * step,
        ms: step * 0.9997,
        attributes: {
          "http.request.method": "GET",
          "url.full": "http://fx-rates.internal/rates?pair=EURUSD",
          "http.response.status_code": 200,
        },
      },
      {
        id: hex("d2", i, 16),
        parent: client,
        name: "GET /rates",
        service: "fx-rates",
        kind: "server",
        at: 58 + i * step + 0.01,
        ms: step * 0.9937,
        attributes: http("GET", "/rates", 200),
      },
    ];
  });

  return [
    {
      id: "9d2e41c07b5a3f18",
      parent: null,
      name: "POST /invoices/overdue",
      service: "ledger-api",
      kind: "server",
      at: 0,
      ms: total,
      attributes: http("POST", "/invoices/overdue", 200),
    },
    {
      id: "a0c4e2b19f7d6e31",
      parent: "9d2e41c07b5a3f18",
      name: "auth.verifySession",
      service: "ledger-api",
      at: 2,
      ms: 6,
    },
    {
      id: "b30e4d1a7c2f9e05",
      parent: "9d2e41c07b5a3f18",
      name: "invoices.recalculateOverdue",
      service: "ledger-api",
      at: 10,
      ms: total - 26,
      attributes: {
        "code.function.name": "recalculateOverdue",
        "code.file.path": "src/invoices/overdue.ts",
        "code.line.number": 22,
      },
    },
    {
      id: "5e7a19c3d04b2f86",
      parent: "b30e4d1a7c2f9e05",
      name: "SELECT invoices",
      service: "ledger-api",
      kind: "client",
      at: 12,
      ms: 42,
      attributes: db(
        "select id, total_cents, currency from invoices where status = 'overdue'",
        48,
        "loadOverdue"
      ),
    },
    ...calls.flat(),
    {
      id: "a91f5d6e7b8c03c2",
      parent: "b30e4d1a7c2f9e05",
      name: "UPDATE invoices",
      service: "ledger-api",
      kind: "client",
      // After the rate lookups, ending 28 ms before the root (112 ms in the 840 ms run).
      at: 60 + window,
      ms: total - 88 - window,
      attributes: db("update invoices set total_cents = $1 where id = any($2)", 61, "saveTotals"),
    },
    {
      id: "e48b0c2d6f1a9735",
      parent: "9d2e41c07b5a3f18",
      name: "res.json",
      service: "ledger-api",
      at: total - 12,
      ms: 8,
    },
  ];
};

/** Turn 12's overdue run: 434 spans, 220 in ledger-api and 214 in fx-rates, 4 levels deep. */
export const BIG_TRACE: TraceSpec = {
  id: "4f1c0e5b7d2a46c1b3e8d90f61a59a2e",
  startedAt: "2026-10-31T14:02:11.204Z",
  turn: FIXTURE_TURNS[12],
  launchedTurn: null,
  spans: overdueRun(214, 640, 840),
};

const ASSERTION = "expect(received).toBe(expected)\n\nExpected: 192000\nReceived: 184000";

/** Turn 12's failing test: an assertion on the root and a timed-out rate lookup under it. */
export const ERROR_TRACE: TraceSpec = {
  id: "7be20d94c1f3a5862e0d4c7b9a13f650",
  startedAt: "2026-10-31T14:01:52.630Z",
  turn: FIXTURE_TURNS[12],
  launchedTurn: null,
  linked: true,
  spans: [
    {
      id: "3c5d7e9f1a2b4c6d",
      parent: null,
      name: "test overdue-totals",
      service: "ledger-tests",
      at: 0,
      ms: 3100,
      status: "error",
      statusMessage: "expect(received).toBe(expected)",
      attributes: {
        "test.name": "overdue totals include fx conversion",
        "code.file.path": "test/overdue-totals.test.ts",
        "code.line.number": 42,
      },
      events: [
        {
          name: "exception",
          at: 3080,
          attributes: {
            "exception.type": "AssertionError",
            "exception.message": ASSERTION,
            "exception.stacktrace": `AssertionError: ${ASSERTION}\n    at <anonymous> (test/overdue-totals.test.ts:42:18)\n    at runTest (node_modules/bun-test/run.js:88:5)`,
          },
        },
      ],
      links: [
        {
          traceId: BIG_TRACE.id,
          spanId: "9d2e41c07b5a3f18",
          traceState: "",
          attributes: { "link.reason": "same route, later run" },
          droppedAttributes: 0,
        },
      ],
    },
    {
      id: "41e6a8c0d2f4b691",
      parent: "3c5d7e9f1a2b4c6d",
      name: "POST /invoices/overdue",
      service: "ledger-tests",
      kind: "client",
      at: 40,
      ms: 2950,
      attributes: {
        "http.request.method": "POST",
        "url.full": "http://localhost:3000/invoices/overdue",
        "http.response.status_code": 200,
      },
    },
    {
      id: "52f7b9d1e3a5c7f2",
      parent: "41e6a8c0d2f4b691",
      name: "POST /invoices/overdue",
      service: "ledger-api",
      kind: "server",
      at: 45,
      ms: 2940,
      attributes: http("POST", "/invoices/overdue", 200),
    },
    {
      id: "63a8cae2f4b6d803",
      parent: "52f7b9d1e3a5c7f2",
      name: "invoices.recalculateOverdue",
      service: "ledger-api",
      at: 50,
      ms: 2900,
    },
    {
      id: "74b9dbf3a5c7e914",
      parent: "63a8cae2f4b6d803",
      name: "SELECT invoices",
      service: "ledger-api",
      kind: "client",
      at: 52,
      ms: 60,
      attributes: db(
        "select id, total_cents, currency from invoices where status = 'overdue'",
        48,
        "loadOverdue"
      ),
    },
    {
      id: "85cae0a4b6d8fa25",
      parent: "63a8cae2f4b6d803",
      name: "GET fx-rates.internal/rates",
      service: "ledger-api",
      kind: "client",
      at: 120,
      ms: 2700,
      status: "error",
      statusMessage: "connect ETIMEDOUT 10.0.4.12:80",
      attributes: {
        "http.request.method": "GET",
        "url.full": "http://fx-rates.internal/rates?pair=EURUSD",
        "error.type": "ETIMEDOUT",
      },
    },
  ],
};

const smallTrace = (
  id: string,
  startedAt: string,
  at: TraceTurn | null,
  route: { method: string; path: string; ms: number },
  query: { name: string; text: string }
): TraceSpec => {
  const root = `${id.slice(0, 14)}01`;

  return {
    id,
    startedAt,
    turn: at,
    launchedTurn: null,
    spans: [
      {
        id: root,
        parent: null,
        name: `${route.method} ${route.path}`,
        service: "ledger-api",
        kind: "server",
        at: 0,
        ms: route.ms,
        attributes: http(route.method, route.path, 200),
      },
      {
        id: `${id.slice(0, 14)}02`,
        parent: root,
        name: query.name,
        service: "ledger-api",
        kind: "client",
        at: route.ms * 0.05,
        ms: route.ms * 0.8,
        attributes: db(query.text, 30, "handler"),
      },
      {
        id: `${id.slice(0, 14)}03`,
        parent: root,
        name: "res.json",
        service: "ledger-api",
        at: route.ms * 0.9,
        ms: route.ms * 0.05,
      },
    ],
  };
};

/** Turn 10's import, after retention removed its batch spans: the third row's parent is gone. */
export const PARTIAL_TRACE: TraceSpec = {
  id: "c06f2b8e4a1d4937a5e0b6c8d2f41e73",
  startedAt: "2026-10-31T13:05:40.018Z",
  turn: FIXTURE_TURNS[10],
  launchedTurn: null,
  partial: true,
  spans: [
    {
      id: "f1a3c5e7092b4d61",
      parent: null,
      name: "POST /invoices/import",
      service: "ledger-api",
      kind: "server",
      at: 0,
      ms: 1920,
      attributes: http("POST", "/invoices/import", 201),
    },
    {
      id: "f2b4d6f8a13c5e72",
      parent: "f1a3c5e7092b4d61",
      name: "csv.parse",
      service: "ledger-api",
      at: 4,
      ms: 210,
    },
    {
      id: "f3c5e7a9b24d6f83",
      parent: "f4d6f8bac35e7094",
      name: "INSERT invoices",
      service: "ledger-api",
      kind: "client",
      at: 1500,
      ms: 380,
      attributes: db(
        "insert into invoices (id, total_cents, currency) values ($1, $2, $3)",
        90,
        "insertBatch"
      ),
    },
  ],
};

export const FIXTURE_TRACES: ReadonlyArray<TraceSpec> = [
  BIG_TRACE,
  ERROR_TRACE,
  smallTrace(
    "1a7e93c5d02b46f8a9c1e3b5d7f90a2c",
    "2026-10-31T14:01:31.870Z",
    FIXTURE_TURNS[12],
    { method: "GET", path: "/invoices?status=overdue", ms: 212 },
    { name: "SELECT invoices", text: "select * from invoices where status = 'overdue'" }
  ),
  smallTrace(
    "2b8fa4d6e13c57a9b0d2f4c6e8a01b3d",
    "2026-10-31T14:01:12.455Z",
    FIXTURE_TURNS[12],
    { method: "GET", path: "/customers/:id", ms: 38 },
    { name: "SELECT customers", text: "select * from customers where id = $1" }
  ),
  smallTrace(
    "3c90b5e7f24d68bac1e3a5d7f9b12c4e",
    "2026-10-31T13:52:08.300Z",
    null,
    { method: "GET", path: "/invoices", ms: 96 },
    { name: "SELECT invoices", text: "select * from invoices order by due_on" }
  ),
  {
    id: "5d0a1c6f8e2b4a97b6c8e0f2a4d63e5f",
    startedAt: "2026-10-31T13:41:20.512Z",
    turn: FIXTURE_TURNS[11],
    launchedTurn: null,
    spans: overdueRun(12, 30, 122),
  },
  {
    id: "6e1b2d7a9f3c5ba8c7d9f1a3b5e74f60",
    startedAt: "2026-10-31T13:41:02.104Z",
    turn: FIXTURE_TURNS[11],
    launchedTurn: null,
    spans: [
      {
        id: "6e1b2d7a9f3c5b01",
        parent: null,
        name: "test overdue-totals",
        service: "ledger-tests",
        at: 0,
        ms: 1400,
        status: "ok",
        attributes: { "code.file.path": "test/overdue-totals.test.ts", "code.line.number": 42 },
      },
    ],
  },
  smallTrace(
    "7f2c3e8b0a4d6cb9d8e0a2b4c6f85a71",
    "2026-10-31T13:05:31.990Z",
    FIXTURE_TURNS[10],
    { method: "GET", path: "/health", ms: 4 },
    { name: "SELECT 1", text: "select 1" }
  ),
  PARTIAL_TRACE,
];

export const FIXTURE_DETAILS: ReadonlyArray<TraceDetail> = FIXTURE_TRACES.map((t) => ({
  ...buildTrace(t, FIXTURE_CHECKOUT),
  // Illustrative history for the accepted Waterfall and Span panel scene.
  usual:
    t.id === BIG_TRACE.id
      ? {
          a91f5d6e7b8c03c2: { usualMs: 9, samples: 12 },
          [t.spans.find((s) => s.name === "auth.verifySession")!.id]: { usualMs: 60, samples: 8 },
        }
      : undefined,
}));

/** Log records, newest last; the failing test's root and its timed-out call have some. */
const LOGS: ReadonlyArray<LogSpec> = [
  {
    id: "log-1",
    trace: ERROR_TRACE,
    spanId: "85cae0a4b6d8fa25",
    at: 1200,
    severity: "WARN",
    body: "fx-rates slow to answer, retrying (1/2)",
    service: "ledger-api",
    attributes: { attempt: 1 },
  },
  {
    id: "log-2",
    trace: ERROR_TRACE,
    spanId: "85cae0a4b6d8fa25",
    at: 2820,
    severity: "ERROR",
    body: "fx-rates request timed out after 2700 ms; using cached EURUSD 1.0712",
    service: "ledger-api",
    attributes: { "error.type": "ETIMEDOUT", pair: "EURUSD" },
  },
  {
    id: "log-3",
    trace: ERROR_TRACE,
    spanId: "3c5d7e9f1a2b4c6d",
    at: 3085,
    severity: "ERROR",
    body: "overdue totals include fx conversion: expected 192000, received 184000",
    service: "ledger-tests",
  },
  {
    id: "log-4",
    trace: ERROR_TRACE,
    spanId: "3c5d7e9f1a2b4c6d",
    at: 3095,
    severity: "INFO",
    body: "1 fail, 11 pass",
    service: "ledger-tests",
  },
  {
    id: "log-5",
    trace: BIG_TRACE,
    spanId: "a91f5d6e7b8c03c2",
    at: 812,
    severity: "INFO",
    body: "saved 214 overdue totals",
    service: "ledger-api",
    attributes: { rows: 214 },
  },
];

export const FIXTURE_LOGS: ReadonlyArray<LogRecord> = LOGS.map((log) =>
  buildLog(log, FIXTURE_CHECKOUT)
);

export const FIXTURE_ENDPOINT = "http://127.0.0.1:4319/otlp/tok_fixture_overdue";

const listening = TraceAvailability.cases.Listening.make({});

/** The receiver's states: listening with traces, listening with none, the port taken, and the user's own exporter. */
export const FIXTURE_SNAPSHOTS = {
  traces: { availability: listening, userExported: false, endpoint: FIXTURE_ENDPOINT },
  empty: { availability: listening, userExported: false, endpoint: FIXTURE_ENDPOINT },
  unavailable: {
    availability: TraceAvailability.cases.Unavailable.make({
      code: "E-TRACE-PORT-IN-USE",
      message: "127.0.0.1:4319 is in use by another process",
      owner: "otelcol-contrib (pid 4127)",
    }),
    userExported: false,
    endpoint: null,
  },
  userExported: { availability: listening, userExported: true, endpoint: null },
} as const satisfies Record<string, Omit<TracesSnapshot, "traces" | "total">>;

export type TracesScene = keyof typeof FIXTURE_SNAPSHOTS;
