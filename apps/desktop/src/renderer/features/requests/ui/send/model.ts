/**
 * The send pane's model (DESIGN.md, Requests → Send pane): the status line, the response body as
 * it reads, the send's trace as a mini waterfall rooted at "send · polaris", and the tables it touched.
 */
import {
  type AdHocRequest,
  type HttpHeader,
  type Send,
  type SendOutcome,
  TRACEPARENT_HEADER,
  type TraceAttributes,
  type TraceDetail,
} from "@polaris/protocol";
import { isWrite } from "../../../data/model/queryLog.ts";
import { type SpanTable, spanTable } from "../../../traces/model/span/dataSource.ts";
import { fieldText } from "../../../traces/model/span/fields.ts";
import {
  holds,
  type SpanNode,
  spanTree,
  traceTimes,
  type WaterfallRow,
  waterfallRows,
} from "../../../traces/model/waterfall/index.ts";

/** The Daemon's Send span (apps/daemon/src/requests/rootSpan.ts). */
export const SEND_SERVICE = "polaris";

export const SEND_SPAN_NAME = "send";

const OUTCOME_TEXT: Record<Exclude<SendOutcome, "ok" | "http-error">, string> = {
  refused: "Connection refused",
  timeout: "Timed out",
  denied: "Denied",
  failed: "Failed",
};

/** "200 OK", or what happened when no response came. */
export const statusLine = (send: Send): string => {
  if (send.status !== undefined)
    return send.statusText === undefined || send.statusText === ""
      ? String(send.status)
      : `${send.status} ${send.statusText}`;

  return send.outcome === "ok" || send.outcome === "http-error"
    ? send.outcome
    : OUTCOME_TEXT[send.outcome];
};

const contentType = (headers: ReadonlyArray<HttpHeader>) =>
  headers.find((h) => h.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";

/** The text re-indented with two spaces, or null when it isn't JSON. */
const prettyJson = (text: string): string | null => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
};

export interface ResponseBody {
  readonly text: string;
  readonly json: boolean;
}

/** JSON pretty-printed with two spaces; a cut body, or one that isn't JSON, reads as it came. */
export const responseBody = (send: Send): ResponseBody | null => {
  const raw = send.responseBody;

  if (raw === undefined || raw === "") return null;
  const looksJson = contentType(send.responseHeaders).includes("json") || /^\s*[[{]/.test(raw);
  const pretty = looksJson && !send.responseTruncated ? prettyJson(raw) : null;

  return pretty === null ? { text: raw, json: false } : { text: pretty, json: true };
};

/** The Daemon's masks for a resolved secret and a redacted value (requests/record.ts). */
const MASKS = ["••••••••", "[redacted]"];

const masked = (text: string | undefined) =>
  text !== undefined && MASKS.some((mask) => text.includes(mask));

/** A send whose recorded request lost a secret to a mask can't be sent again as recorded. */
export const lostSecret = (send: Send) =>
  masked(send.url) || masked(send.requestBody) || send.requestHeaders.some((h) => masked(h.value));

/** An agent's send not saved as a Request: "not saved", "Save as request", "Send again". */
export const isAdHocAgentSend = (send: Send) =>
  send.requestRef === null && send.by.kind === "agent";

/** The recorded request as written, without the `traceparent` Polaris added, so a resend gets its own trace. */
export const recordedRequest = (send: Send): AdHocRequest => {
  const headers = send.requestHeaders.filter((h) => h.name.toLowerCase() !== TRACEPARENT_HEADER);
  const request = { method: send.method, url: send.url, headers };

  return send.requestBody === undefined ? request : { ...request, body: send.requestBody };
};

export interface SendWaterfall {
  readonly rows: ReadonlyArray<WaterfallRow>;
  /** The window the bars are drawn in, in ms after the trace's start. */
  readonly from: number;
  readonly to: number;
  /** Each service's index for its hue, by first appearance (Traces' order). */
  readonly hues: ReadonlyMap<string, number>;
  readonly spans: number;
}

const isSendSpan = (node: SpanNode) =>
  node.service === SEND_SERVICE && node.name === SEND_SPAN_NAME && !node.fold;

/** The trace as Traces draws it, from the send span down; other roots follow it. */
export const sendWaterfall = (detail: TraceDetail): SendWaterfall | null => {
  const times = traceTimes(detail);
  const roots = spanTree(times);
  const root = roots.find(isSendSpan);
  const ordered = root === undefined ? roots : [root, ...roots.filter((r) => r !== root)];
  const rows = waterfallRows(ordered, { collapsed: new Set(), focus: null });
  const first = ordered[0];

  if (first === undefined) return null;
  const to = Math.max(times.end, first.end);

  return {
    rows,
    from: Math.min(first.start, ...ordered.map((r) => r.start)),
    to,
    hues: new Map(times.services.map((s) => [s.name, s.index])),
    spans: times.spans.length,
  };
};

export { holds };

export type TableTouch = "wrote" | "read" | "write failed" | "read failed";

export interface TouchedTable {
  readonly key: string;
  readonly table: SpanTable;
  /** The database span to open: a failed one first, then a write, else the first read. */
  readonly spanId: string;
  readonly touch: TableTouch;
  readonly statements: number;
}

/** The SQL a database span ran, as recorded; null when it kept none. */
export const statementOf = (attributes: TraceAttributes) => {
  const sql = attributes["db.query.text"] ?? attributes["db.statement"];

  return sql === undefined || sql === null ? null : fieldText(sql);
};

const WRITE_OPERATIONS = /^(insert|update|delete|merge|upsert|replace|create|alter|drop|truncate)/i;

const writes = (attributes: TraceAttributes) => {
  const sql = statementOf(attributes);

  if (sql !== null) return isWrite(sql);
  const op = attributes["db.operation.name"] ?? attributes["db.operation"];

  return op !== undefined && op !== null && WRITE_OPERATIONS.test(fieldText(op));
};

const isDatabase = (attributes: TraceAttributes) =>
  attributes["db.system.name"] !== undefined || attributes["db.system"] !== undefined;

const RANK: Record<TableTouch, number> = {
  "write failed": 3,
  "read failed": 2,
  wrote: 1,
  read: 0,
};

const touchOf = (wrote: boolean, error: boolean): TableTouch =>
  error ? (wrote ? "write failed" : "read failed") : wrote ? "wrote" : "read";

const tableKey = (attributes: TraceAttributes, table: SpanTable) => {
  const namespace = attributes["db.namespace"] ?? attributes["db.name"];
  const database = namespace === undefined || namespace === null ? "" : fieldText(namespace);

  return [database, table.schema ?? "", table.name].join("\u0000");
};

/** Each table the trace's database spans name, once, by what happened to it at its worst. */
export const touchedTables = (detail: TraceDetail): ReadonlyArray<TouchedTable> => {
  const found = new Map<string, TouchedTable>();

  for (const span of detail.spans) {
    if (!isDatabase(span.attributes)) continue;
    const table = spanTable(span.attributes);

    if (table === null) continue;
    const key = tableKey(span.attributes, table);
    const touch = touchOf(writes(span.attributes), span.status === "error");
    const seen = found.get(key);

    if (seen === undefined) found.set(key, { key, table, spanId: span.id, touch, statements: 1 });
    else
      found.set(key, {
        ...seen,
        statements: seen.statements + 1,
        ...(RANK[touch] > RANK[seen.touch] ? { touch, spanId: span.id } : undefined),
      });
  }

  return [...found.values()];
};
