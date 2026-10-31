/** Lazy worker entrypoint: decode, redact, batch and query without blocking the Daemon's event loop. */
import type { Database } from "bun:sqlite";
import { Match, Schema } from "effect";
import { TraceError } from "@polaris/protocol";
import { decodeBatch } from "./decoder.ts";
import {
  DEFAULT_RETENTION,
  openTraceDatabase,
  refreshSummary,
  writeBatch,
  type Retention,
} from "./database.ts";
import { IngestError, MAX_QUEUED_BYTES, type DecodedBatch } from "./ingest.ts";
import {
  getSpan,
  getTrace,
  linkTrace,
  listTraces,
  traceHistory,
  overlappingTraces,
} from "./queries.ts";
import { pruneCheckout } from "./retention.ts";
import { TraceWorkerMessage, TraceWorkerReply, TraceWorkerRequest } from "./workerProtocol.ts";

declare const self: Worker;

let db: Database | null = null;

let retention: Retention = DEFAULT_RETENTION;

let flushMs = 25;

let pending: DecodedBatch[] = [];

let pendingBytes = 0;

let pendingRecords = 0;

let timer: ReturnType<typeof setTimeout> | undefined;

let failed = false;

const storageError = () =>
  new TraceError({
    code: "E-TRACE-UNAVAILABLE",
    message: "The trace store is unavailable.",
    fix: "Check free space and permissions in the Daemon's home, then retry.",
  });

const database = (): Database => {
  if (db === null) throw storageError();

  return db;
};

const changed = () => self.postMessage(TraceWorkerReply.cases.Changed.make({}));

const flush = (): void => {
  clearTimeout(timer);
  timer = undefined;

  if (pending.length === 0) return;
  const store = database();
  const batch = { spans: pending.flatMap((b) => b.spans), logs: pending.flatMap((b) => b.logs) };

  try {
    store.transaction(() => {
      const touched = writeBatch(store, batch);

      for (const [checkout, ids] of touched) {
        for (const id of ids) refreshSummary(store, checkout, id);
        pruneCheckout(store, checkout, retention, Date.now());
      }
    })();
    failed = false;
    pending = [];
    pendingBytes = 0;
    pendingRecords = 0;
    store.exec("PRAGMA incremental_vacuum(256)");
    changed();
  } catch {
    failed = true;
    throw storageError();
  }
};

const scheduleFlush = () => {
  if (timer !== undefined && pendingRecords < 1000) return;
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      try {
        flush();
      } catch {
        changed();
      }
    },
    pendingRecords >= 1000 ? 0 : flushMs
  );
};

const prune = (checkout: string) => {
  flush();
  const store = database();
  const removed = store.transaction(() => pruneCheckout(store, checkout, retention, Date.now()))();

  if (removed) {
    store.exec("PRAGMA incremental_vacuum(256)");
    changed();
  }

  return store;
};

const handle = Match.type<TraceWorkerRequest>().pipe(
  Match.tag("Open", (request) => {
    db = openTraceDatabase(request.filename);
    retention = { maxBytes: request.maxBytes, maxAgeMs: request.maxAgeMs };
    flushMs = request.flushMs;

    return null;
  }),
  Match.tag("Ingest", (request) => {
    database();

    if (failed) flush();
    let batch: DecodedBatch;

    try {
      batch = decodeBatch(request.bytes, request.signal, request.contentType, request.context);
    } catch (cause) {
      if (cause instanceof IngestError) throw cause;
      throw new IngestError(400, "The OTLP batch could not be decoded.");
    }

    const bytes = batch.bytes;

    const checkoutBytes = pending.reduce(
      (total, queued) =>
        total +
        ((queued.spans[0]?.polaris.checkout ?? queued.logs[0]?.polaris.checkout) ===
        request.context.checkout
          ? queued.bytes
          : 0),
      0
    );

    if (pendingBytes + bytes > MAX_QUEUED_BYTES || checkoutBytes + bytes > MAX_QUEUED_BYTES / 2)
      throw new IngestError(429, "Trace ingest queue is full");

    pending.push(batch);
    pendingBytes += bytes;
    const records = batch.spans.length + batch.logs.length;
    pendingRecords += records;

    if (pendingRecords >= 1000) flush();
    else scheduleFlush();

    return records;
  }),
  Match.tag("List", (request) =>
    listTraces(prune(request.checkout), request.checkout, request.filter)
  ),
  Match.tag("Overlap", (request) =>
    overlappingTraces(prune(request.checkout), request.checkout, request.start, request.end)
  ),
  Match.tag("Get", (request) =>
    getTrace(prune(request.checkout), request.checkout, request.traceId)
  ),
  Match.tag("Span", (request) =>
    getSpan(prune(request.checkout), request.checkout, request.traceId, request.spanId)
  ),
  Match.tag("History", (request) =>
    traceHistory(prune(request.checkout), request.checkout, request.traceId, request.includeSpans)
  ),
  Match.tag("Link", (request) => {
    flush();
    linkTrace(database(), request.checkout, request.traceId);
    changed();

    return null;
  }),
  Match.tag("Flush", () => {
    flush();

    return null;
  }),
  Match.tag("Close", () => {
    flush();
    db?.close();
    db = null;

    return null;
  }),
  Match.exhaustive
);

const decode = Schema.decodeUnknownSync(TraceWorkerMessage);

self.onmessage = (event: MessageEvent<unknown>) => {
  const { id, request } = decode(event.data);

  try {
    const value = handle(request);
    self.postMessage(TraceWorkerReply.cases.Success.make({ id, value }));
  } catch (cause) {
    const status = cause instanceof IngestError ? cause.status : 503;

    const error =
      cause instanceof TraceError
        ? cause
        : new TraceError({
            code: "E-TRACE-UNAVAILABLE",
            message: "The OTLP batch could not be decoded.",
            fix: "Send a valid, bounded OTLP/HTTP traces or logs request.",
          });

    self.postMessage(
      TraceWorkerReply.cases.Failure.make({
        id,
        status,
        error: { code: error.code, message: error.message, fix: error.fix },
      })
    );
  }
};
