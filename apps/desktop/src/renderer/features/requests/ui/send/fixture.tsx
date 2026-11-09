/**
 * The send pane on fixtures, for previews and tests: the traces two sends started (a user's 200
 * that wrote invoices, and an agent's ad-hoc send whose write failed), and Traces and Data layers
 * that answer for them, no Daemon involved.
 */
import { Send, SessionId, type TraceDetail, TraceId, TurnId } from "@polaris/protocol";
import type { ReactNode } from "react";
import { DataLayer } from "../../../data/data/hooks.tsx";
import { fixtureDataApi } from "../../../data/preview/fixtureApi.ts";
import { TracesLayer } from "../../../traces/data/hooks.tsx";
import type { TracesApi } from "../../../traces/data/api.ts";
import { buildTrace, type SpanSpec, type TraceSpec } from "../../../traces/preview/build.ts";
import { FIXTURE_CHECKOUT } from "../../../traces/preview/fixtures.ts";
import { fixtureTracesApi } from "../../../traces/preview/fixtureApi.ts";

const pg = (query: string) => ({
  "db.system.name": "postgresql",
  "db.namespace": "ledger_overdue",
  "db.query.text": query,
  "server.address": "localhost",
  "server.port": 5432,
});

const sendSpan = (id: string, path: string, ms: number, status: number): SpanSpec => ({
  status: status >= 400 ? "error" : "unset",
  id,
  parent: null,
  name: "send",
  service: "polaris",
  kind: "client",
  at: 0,
  ms,
  attributes: {
    "http.request.method": "POST",
    "url.full": `http://localhost:4000${path}`,
    "http.response.status_code": status,
  },
});

/** The user's "Recalculate overdue": a read, a call out to fx, two writes. */
export const SEND_TRACE: TraceSpec = {
  id: "4f1c9a2e4f1c9a2e4f1c9a2e4f1c9a2e",
  startedAt: "2026-11-09T14:02:11.000Z",
  turn: null,
  launchedTurn: null,
  spans: [
    sendSpan("a1b2c3d4e5f60718", "/invoices/overdue/recalculate", 840, 200),
    {
      id: "b1b2c3d4e5f60718",
      parent: "a1b2c3d4e5f60718",
      name: "POST /invoices/overdue/recalculate",
      service: "ledger-api",
      kind: "server",
      at: 6,
      ms: 826,
    },
    {
      id: "c1b2c3d4e5f60718",
      parent: "b1b2c3d4e5f60718",
      name: "SELECT ledger_overdue",
      service: "ledger-api",
      kind: "client",
      at: 14,
      ms: 92,
      attributes: pg("SELECT id, credit_limit FROM customers WHERE overdue_since IS NOT NULL"),
    },
    {
      id: "d1b2c3d4e5f60718",
      parent: "b1b2c3d4e5f60718",
      name: "GET /rates",
      service: "fx-rates",
      kind: "server",
      at: 112,
      ms: 64,
    },
    {
      id: "e1b2c3d4e5f60718",
      parent: "b1b2c3d4e5f60718",
      name: "UPDATE ledger_overdue",
      service: "ledger-api",
      kind: "client",
      at: 184,
      ms: 548,
      attributes: pg("UPDATE invoices SET overdue_total = $1 WHERE id = ANY($2)"),
    },
    {
      id: "f1b2c3d4e5f60718",
      parent: "b1b2c3d4e5f60718",
      name: "INSERT ledger_overdue",
      service: "ledger-api",
      kind: "client",
      at: 742,
      ms: 61,
      attributes: pg("INSERT INTO audit_log (kind, detail) VALUES ('recalculate', $1)"),
    },
  ],
};

/** An agent's ad-hoc send: the write to invoices failed and the server answered 500. */
export const AGENT_TRACE: TraceSpec = {
  id: "9e0d7c6b5a4938271605f4e3d2c1b0a9",
  startedAt: "2026-11-09T14:06:40.000Z",
  turn: null,
  launchedTurn: null,
  spans: [
    sendSpan("0a1b2c3d4e5f6071", "/invoices/42/void", 212, 500),
    {
      id: "1a1b2c3d4e5f6071",
      parent: "0a1b2c3d4e5f6071",
      name: "POST /invoices/:id/void",
      service: "ledger-api",
      kind: "server",
      at: 4,
      ms: 204,
      status: "error",
    },
    {
      id: "2a1b2c3d4e5f6071",
      parent: "1a1b2c3d4e5f6071",
      name: "SELECT ledger_overdue",
      service: "ledger-api",
      kind: "client",
      at: 10,
      ms: 22,
      attributes: pg("SELECT status FROM invoices WHERE id = $1"),
    },
    {
      id: "3a1b2c3d4e5f6071",
      parent: "1a1b2c3d4e5f6071",
      name: "UPDATE ledger_overdue",
      service: "ledger-api",
      kind: "client",
      at: 40,
      ms: 150,
      status: "error",
      statusMessage: 'new row violates check constraint "invoices_status_check"',
      attributes: pg("UPDATE invoices SET status = 'void' WHERE id = $1"),
    },
  ],
};

const DETAILS: ReadonlyArray<TraceDetail> = [SEND_TRACE, AGENT_TRACE].map((t) =>
  buildTrace(t, FIXTURE_CHECKOUT)
);

/** Traces answering for the sends' traces; everything else as Traces' own fixtures. */
export const sendTracesApi = (details: ReadonlyArray<TraceDetail> = DETAILS): TracesApi => {
  const base = fixtureTracesApi();

  return {
    ...base,
    watch: (at, filter, on) =>
      base.watch(at, filter, {
        ...on,
        next: (snapshot) =>
          on.next({ ...snapshot, traces: details.map((d) => d.summary), total: details.length }),
      }),
    get: (at, traceId) => {
      const found = details.find((d) => d.summary.id.startsWith(traceId));

      return found === undefined
        ? base.get(at, traceId)
        : Promise.resolve({ ok: true, value: found });
    },
  };
};

/** An agent's send not saved as a Request, as the send log would hand it over. */
/** The agent's send's fields, for tests that vary one. */
export const AGENT_SEND_FIELDS: ConstructorParameters<typeof Send>[0] = {
  id: "send-agent-1",
  checkout: FIXTURE_CHECKOUT.checkout,
  requestRef: null,
  environment: "dev",
  method: "POST",
  url: "http://localhost:4000/invoices/42/void",
  requestHeaders: [
    { name: "content-type", value: "application/json" },
    { name: "traceparent", value: `00-${AGENT_TRACE.id}-0a1b2c3d4e5f6071-01` },
  ],
  requestBody: '{ "reason": "duplicate" }',
  status: 500,
  statusText: "Internal Server Error",
  responseHeaders: [{ name: "content-type", value: "application/json" }],
  responseBody: '{"error":"check constraint invoices_status_check","invoice":42}',
  responseTruncated: false,
  durationMs: 212,
  traceId: TraceId.make(AGENT_TRACE.id),
  startedAt: AGENT_TRACE.startedAt,
  by: {
    kind: "agent",
    sessionId: SessionId.make(FIXTURE_CHECKOUT.sessionId),
    turn: TurnId.make("t-overdue-12"),
  },
  outcome: "http-error",
};

export const AGENT_SEND = new Send(AGENT_SEND_FIELDS);

/** Traces and Data on fixtures around the send pane. */
export const SendFixtureLayers = ({ children }: { readonly children: ReactNode }) => (
  <TracesLayer api={sendTracesApi()}>
    <DataLayer api={fixtureDataApi()}>{children}</DataLayer>
  </TracesLayer>
);
