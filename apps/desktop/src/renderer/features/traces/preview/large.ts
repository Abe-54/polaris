/**
 * A 10,000-span trace for measuring the waterfall (`#traces/large`): a report rebuild across six
 * services, 5 levels deep, an error every seventh batch, and no repeated siblings, so nothing
 * folds and all 10,000 rows go through the virtualiser. Built only when that scene is open.
 */
import type { TraceDetail, TraceSummary } from "@polaris/protocol";
import type { TracesApi } from "../data/api.ts";
import { buildTrace, type SpanSpec, type TraceSpec } from "./build.ts";
import { FIXTURE_CHECKOUT, FIXTURE_TURNS } from "./fixtures.ts";
import { meshTrace } from "./mesh.ts";

export const LARGE_SPANS = 10_000;

const BATCHES = 40;

const BATCH_MS = 220;

const ROWS = 60;

const RATES = 20;

const FONTS = 10;

const id = (n: number) => `e${n.toString(16).padStart(15, "0")}`;

/** One batch: a query, row fetches (client, server, query), rate lookups, a render. */
const batch = (b: number, next: () => string): ReadonlyArray<SpanSpec> => {
  const at = 40 + b * BATCH_MS;
  const self = next();

  const spans: Array<SpanSpec> = [
    {
      id: self,
      parent: "e000000000000000",
      name: `reports.buildBatch ${b + 1}`,
      service: "report-api",
      at,
      ms: 210,
    },
    {
      id: next(),
      parent: self,
      name: "SELECT ledger_rows",
      service: "report-api",
      kind: "client",
      at: at + 1,
      ms: 9,
    },
  ];

  for (let r = 0; r < ROWS; r++) {
    const client = next();
    const server = next();
    const start = at + 11 + r * 1.9;

    spans.push(
      {
        id: client,
        parent: self,
        name: `GET ledger-api/rows?id=${b * ROWS + r}`,
        service: "report-api",
        kind: "client",
        at: start,
        ms: 1.8,
      },
      {
        id: server,
        parent: client,
        name: "GET /rows",
        service: "ledger-api",
        kind: "server",
        at: start + 0.05,
        ms: 1.7,
      },
      {
        id: next(),
        parent: server,
        name: "SELECT rows",
        service: "ledger-api",
        kind: "client",
        at: start + 0.1,
        ms: 1.2,
      }
    );
  }

  for (let f = 0; f < RATES; f++) {
    const client = next();
    const start = at + 126 + f * 2.6;
    const failed = b % 7 === 3 && f === 11;

    spans.push(
      {
        id: client,
        parent: self,
        name: `GET fx-rates/rate?day=${f + 1}`,
        service: "report-api",
        kind: "client",
        at: start,
        ms: 2.5,
        status: failed ? "error" : "unset",
        statusMessage: failed ? "connect ETIMEDOUT" : "",
      },
      {
        id: next(),
        parent: client,
        name: "GET /rate",
        service: "fx-rates",
        kind: "server",
        at: start + 0.05,
        ms: 2.3,
      }
    );
  }

  const render = next();

  spans.push({
    id: render,
    parent: self,
    name: "render.pdf",
    service: "renderer",
    at: at + 180,
    ms: 28,
  });

  for (let f = 0; f < FONTS; f++)
    spans.push({
      id: next(),
      parent: render,
      name: `font.load ${f + 1}`,
      service: "renderer",
      at: at + 181 + f * 2,
      ms: 1.6,
    });

  return spans;
};

const spans = (): ReadonlyArray<SpanSpec> => {
  let n = 0;
  const next = () => id(++n);

  const all: Array<SpanSpec> = [
    {
      id: id(0),
      parent: null,
      name: "POST /reports/rebuild",
      service: "report-api",
      kind: "server",
      at: 0,
      ms: 40 + BATCHES * BATCH_MS + 60,
    },
  ];

  for (let b = 0; b < BATCHES; b++) all.push(...batch(b, next));
  // The rest are audit writes after the batches, so the trace is exactly LARGE_SPANS.
  const audit = next();

  all.push({
    id: audit,
    parent: id(0),
    name: "audit.flush",
    service: "audit-log",
    at: 40 + BATCHES * BATCH_MS,
    ms: 50,
  });

  while (all.length < LARGE_SPANS) {
    const i = all.length;

    all.push({
      id: next(),
      parent: audit,
      name: `audit.write ${i}`,
      service: "audit-log",
      at: 40 + BATCHES * BATCH_MS + (i % 48),
      ms: 0.8,
    });
  }

  return all;
};

export const largeTrace = (): TraceSpec => ({
  id: "f00dfeed5a1e4c0ba7d3e9c1b2a40000",
  startedAt: "2026-10-31T14:02:40.000Z",
  turn: FIXTURE_TURNS[12],
  launchedTurn: null,
  spans: spans(),
});

/** The extra trace a scene lists first: `large` for the waterfall, `mesh` for the service map. */
const extraTrace = (hash: string): (() => TraceSpec) | null => {
  if (/^#traces\/large(?:$|\?)/.test(hash)) return largeTrace;

  return /^#traces\/mesh(?:$|\?)/.test(hash) ? () => meshTrace(FIXTURE_TURNS[12]) : null;
};

/** In the `large` and `mesh` scenes, the fixture api plus their big trace, listed first. */
export const withLargeTrace = (hash: string, api: TracesApi): TracesApi => {
  const extra = extraTrace(hash);

  if (extra === null) return api;
  const detail: TraceDetail = buildTrace(extra(), FIXTURE_CHECKOUT);
  const summary: TraceSummary = detail.summary;

  return {
    watch: (at, filter, on) =>
      api.watch(at, filter, {
        ...on,
        next: (snapshot) =>
          on.next({
            ...snapshot,
            traces: [summary, ...snapshot.traces],
            total: snapshot.total + 1,
          }),
      }),
    get: (at, traceId) =>
      summary.id.startsWith(traceId)
        ? Promise.resolve({ ok: true, value: detail })
        : api.get(at, traceId),
    span: (at, traceId, spanId) => {
      const span = detail.spans.find((s) => s.id.startsWith(spanId));

      return summary.id.startsWith(traceId) && span !== undefined
        ? Promise.resolve({ ok: true, value: { span, logs: [], logCount: 0 } })
        : api.span(at, traceId, spanId);
    },
    compare: api.compare,
  };
};
