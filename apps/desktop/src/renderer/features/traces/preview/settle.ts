/**
 * Turn 11's settlement run, the service map's multi-service fixture: a script calls ledger-api,
 * which calls fx-rates, audit-log and (over Kafka) notifier; postgresql, redis and the mail API
 * send no spans, so the map infers them; notifier sends 12 emails in one request, one failing.
 */
import type { TraceTurn } from "@polaris/protocol";
import type { SpanSpec, TraceSpec } from "./build.ts";

export const SETTLE_TRACE_ID = "8a3d5f7b9c1e4f20a6b8c0d2e4f61a3b";

const id = (n: number) => `8a3d${n.toString(16).padStart(12, "0")}`;

const http = (method: string, url: string, status: number) => ({
  "http.request.method": method,
  "url.full": url,
  "http.response.status_code": status,
});

const route = (method: string, path: string, status: number) => ({
  "http.request.method": method,
  "http.route": path,
  "http.response.status_code": status,
});

const sql = (text: string) => ({
  "db.system.name": "postgresql",
  "db.namespace": "ledger",
  "db.query.text": text,
  "server.address": "localhost",
  "server.port": 5432,
});

/** Three rate lookups, each through fx-rates to its redis cache. */
const rates = (): ReadonlyArray<SpanSpec> =>
  [0, 1, 2].flatMap((i): ReadonlyArray<SpanSpec> => {
    const at = 40 + i * 34;

    return [
      {
        id: id(0x10 + i),
        parent: id(3),
        name: "GET fx-rates.internal/rates",
        service: "ledger-api",
        kind: "client",
        at,
        ms: 32,
        attributes: http("GET", "http://fx-rates.internal/rates?pair=EURUSD", 200),
      },
      {
        id: id(0x20 + i),
        parent: id(0x10 + i),
        name: "GET /rates",
        service: "fx-rates",
        kind: "server",
        at: at + 1,
        ms: 30,
        attributes: route("GET", "/rates", 200),
      },
      {
        id: id(0x30 + i),
        parent: id(0x20 + i),
        name: "GET rates:EURUSD",
        service: "fx-rates",
        kind: "client",
        at: at + 2,
        ms: 3,
        attributes: { "db.system.name": "redis", "server.address": "cache.internal" },
      },
    ];
  });

/** notifier's 12 receipts, one per settled invoice; the ninth gets a 502. */
const emails = (): ReadonlyArray<SpanSpec> =>
  Array.from({ length: 12 }, (_, i) => ({
    id: id(0x50 + i),
    parent: id(0x41),
    name: "POST api.postmarkapp.com/email",
    service: "notifier",
    kind: "client" as const,
    at: 420 + i * 62,
    ms: i === 8 ? 140 : 58,
    status: i === 8 ? ("error" as const) : ("unset" as const),
    statusMessage: i === 8 ? "502 Bad Gateway" : "",
    attributes: {
      ...http("POST", "https://api.postmarkapp.com/email", i === 8 ? 502 : 200),
      "server.address": "api.postmarkapp.com",
    },
  }));

export const settleTrace = (turn: TraceTurn): TraceSpec => ({
  id: SETTLE_TRACE_ID,
  startedAt: "2026-10-31T13:44:10.250Z",
  turn,
  launchedTurn: null,
  commands: { "settle-job": "bun run scripts/settle.ts --month 2026-10" },
  spans: [
    { id: id(1), parent: null, name: "settlements.run", service: "settle-job", at: 0, ms: 1240 },
    {
      id: id(2),
      parent: id(1),
      name: "POST ledger-api/settlements",
      service: "settle-job",
      kind: "client",
      at: 6,
      ms: 1220,
      attributes: http("POST", "http://localhost:3000/settlements", 201),
    },
    {
      id: id(3),
      parent: id(2),
      name: "POST /settlements",
      service: "ledger-api",
      kind: "server",
      at: 8,
      ms: 1214,
      attributes: route("POST", "/settlements", 201),
    },
    {
      id: id(4),
      parent: id(3),
      name: "SELECT invoices",
      service: "ledger-api",
      kind: "client",
      at: 12,
      ms: 24,
      attributes: sql("select id, total_cents from invoices where status = 'overdue'"),
    },
    ...rates(),
    {
      id: id(5),
      parent: id(3),
      name: "INSERT settlements",
      service: "ledger-api",
      kind: "client",
      at: 150,
      ms: 64,
      attributes: sql("insert into settlements (invoice_id, total_cents) values ($1, $2)"),
    },
    {
      id: id(0x40),
      parent: id(3),
      name: "settlements.created publish",
      service: "ledger-api",
      kind: "producer",
      at: 220,
      ms: 6,
      attributes: { "messaging.system": "kafka", "messaging.destination.name": "settlements" },
    },
    {
      id: id(0x41),
      parent: id(0x40),
      name: "settlements.created process",
      service: "notifier",
      kind: "consumer",
      at: 400,
      ms: 800,
      attributes: { "messaging.system": "kafka", "messaging.destination.name": "settlements" },
    },
    ...emails(),
    {
      id: id(6),
      parent: id(3),
      name: "POST audit-log/events",
      service: "ledger-api",
      kind: "client",
      at: 230,
      ms: 40,
      attributes: http("POST", "http://audit-log.internal/events", 202),
    },
    {
      id: id(7),
      parent: id(6),
      name: "POST /events",
      service: "audit-log",
      kind: "server",
      at: 232,
      ms: 36,
      attributes: route("POST", "/events", 202),
    },
    {
      id: id(8),
      parent: id(7),
      name: "INSERT audit_events",
      service: "audit-log",
      kind: "client",
      at: 236,
      ms: 22,
      attributes: sql("insert into audit_events (kind, body) values ($1, $2)"),
    },
  ],
});
