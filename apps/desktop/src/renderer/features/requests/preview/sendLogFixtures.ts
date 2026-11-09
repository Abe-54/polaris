/**
 * The ledger checkout's Send Log for previews and tests (Paper Q2, Q3): the user's and an agent's
 * Sends over the last hours, a refused one and a denied one, each `minutesAgo` before `now`.
 */
import { Send, SessionId, TraceId, TurnId } from "@polaris/protocol";

type Mutable<A> = { -readonly [K in keyof A]: A[K] };

export const LEDGER_CHECKOUT = "/Users/lucas/code/ledger.worktrees/overdue-totals";

const SESSION = SessionId.make("s-overdue-totals");

const JSON_TYPE = { name: "Content-Type", value: "application/json" };

export interface SendSpec {
  readonly id: string;
  readonly minutesAgo: number;
  /** "dev" when absent. */
  readonly environment?: string;
  readonly method: Send["method"];
  readonly url: string;
  readonly outcome: Send["outcome"];
  readonly status?: number;
  readonly durationMs: number;
  readonly agent?: boolean;
  readonly ref?: { readonly file: string; readonly name: string };
  readonly body?: string;
}

const STATUS_TEXT = new Map([
  [200, "OK"],
  [201, "Created"],
  [404, "Not Found"],
  [422, "Unprocessable Entity"],
  [500, "Internal Server Error"],
]);

export const fixtureSend = (spec: SendSpec, now: number): Send => {
  const fields: Mutable<ConstructorParameters<typeof Send>[0]> = {
    id: spec.id,
    checkout: LEDGER_CHECKOUT,
    requestRef: spec.ref ?? null,
    environment: spec.environment ?? "dev",
    method: spec.method,
    url: spec.url,
    requestHeaders: spec.body === undefined ? [] : [JSON_TYPE],
    responseHeaders: spec.status === undefined ? [] : [JSON_TYPE],
    responseTruncated: false,
    durationMs: spec.durationMs,
    traceId: spec.outcome === "denied" ? null : TraceId.make(spec.id.padEnd(32, "0").slice(0, 32)),
    startedAt: new Date(now - spec.minutesAgo * 60_000).toISOString(),
    by:
      spec.agent === true
        ? { kind: "agent", sessionId: SESSION, turn: TurnId.make("t-12") }
        : { kind: "user", sessionId: SESSION },
    outcome: spec.outcome,
  };

  if (spec.status !== undefined) {
    fields.status = spec.status;
    fields.statusText = STATUS_TEXT.get(spec.status) ?? "";
    fields.responseBody = '{ "ok": true }';
  }

  if (spec.body !== undefined) fields.requestBody = spec.body;

  if (spec.outcome === "denied") fields.durationMs = 0;

  return new Send(fields);
};

const INVOICES = "http/invoices.http";

export const SEND_SPECS: ReadonlyArray<SendSpec> = [
  {
    id: "a1f0c2d4",
    minutesAgo: 2,
    method: "POST",
    url: "http://localhost:4000/invoices/overdue?recalculate=true",
    outcome: "ok",
    status: 200,
    durationMs: 840,
    ref: { file: INVOICES, name: "Recalculate overdue" },
    body: '{ "customerId": "cus_8f2a" }',
  },
  {
    id: "b2e1d3c5",
    minutesAgo: 9,
    method: "POST",
    url: "https://staging.ledger.dev/invoices/overdue",
    outcome: "denied",
    durationMs: 0,
    agent: true,
    body: '{ "customerId": "cus_8f2a" }',
  },
  {
    id: "c3d2e4b6",
    minutesAgo: 14,
    method: "GET",
    url: "http://localhost:4000/invoices/overdue?limit=50&customer=cus_8f2a&include=lines",
    outcome: "ok",
    status: 200,
    durationMs: 46,
    agent: true,
  },
  {
    id: "d4c3f5a7",
    minutesAgo: 31,
    method: "PATCH",
    url: "http://localhost:4000/invoices/inv_2291",
    outcome: "http-error",
    status: 422,
    durationMs: 112,
    ref: { file: INVOICES, name: "Mark paid" },
    body: '{ "status": "paid" }',
  },
  {
    id: "e5b4a6f8",
    minutesAgo: 95,
    method: "GET",
    url: "http://localhost:4000/healthz",
    outcome: "refused",
    durationMs: 3,
  },
  {
    id: "f6a5b7e9",
    minutesAgo: 140,
    method: "POST",
    url: "http://localhost:4000/invoices/overdue?recalculate=true",
    outcome: "http-error",
    status: 500,
    durationMs: 1260,
    agent: true,
    ref: { file: INVOICES, name: "Recalculate overdue" },
  },
  {
    id: "a7f6c8d0",
    minutesAgo: 170,
    method: "GET",
    url: "http://localhost:4000/customers/cus_8f2a",
    outcome: "timeout",
    durationMs: 30_000,
  },
];

export const fixtureSends = (now: number, specs: ReadonlyArray<SendSpec> = SEND_SPECS) =>
  specs.map((spec) => fixtureSend(spec, now));
