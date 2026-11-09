/**
 * A `RequestsApi` on Paper Q1's ledger checkout, for previews and tests only: never a fallback
 * for the live one. Saves change the in-memory files and re-emit; sends answer 200 at once.
 */
import {
  type AdHocRequest,
  HttpRequest,
  RequestAuth,
  RequestFile,
  type RequestsSnapshot,
  RequestTarget,
  type ResolvedVariable,
  Send,
  SendLookup,
  SessionId,
  TraceId,
} from "@polaris/protocol";
import type { RequestsApi, SendInput, Watch } from "../data/api.ts";

type Mutable<A> = { -readonly [K in keyof A]: A[K] };

const INVOICES = "http/invoices.http";

const CUSTOMERS = "http/customers.http";

const WEBHOOKS = "http/webhooks.http";

const JSON_TYPE = { name: "Content-Type", value: "application/json" };

const BEARER = RequestAuth.cases.Bearer.make({ token: "{{$dotenv LEDGER_TOKEN}}" });

const request = (
  file: string,
  line: number,
  name: string,
  method: HttpRequest["method"],
  url: string,
  extra: Partial<Pick<HttpRequest, "headers" | "body" | "auth">> = {}
) => new HttpRequest({ file, line, name, method, url, headers: [], auth: BEARER, ...extra });

const RECALCULATE_BODY = `{
  "customerId": "cus_8f2a",
  "asOf": "{{$isoTimestamp}}",
  "currency": "EUR",
  "includeDisputed": false
}
`;

const FILES: ReadonlyArray<RequestFile> = [
  new RequestFile({
    path: INVOICES,
    parseErrors: [],
    requests: [
      request(INVOICES, 1, "List overdue", "GET", "{{base}}/invoices/overdue?limit=50"),
      request(
        INVOICES,
        14,
        "Recalculate overdue",
        "POST",
        "{{base}}/invoices/overdue?recalculate=true",
        {
          headers: [
            JSON_TYPE,
            { name: "Accept", value: "application/json" },
            { name: "X-Request-Source", value: "polaris" },
          ],
          body: RECALCULATE_BODY,
        }
      ),
      request(INVOICES, 28, "Mark paid", "PATCH", "{{base}}/invoices/{{invoiceId}}", {
        headers: [JSON_TYPE],
        body: '{ "status": "paid" }\n',
      }),
      request(INVOICES, 36, "Void invoice", "DELETE", "{{base}}/invoices/{{invoiceId}}"),
      request(INVOICES, 41, "Export overdue as CSV", "GET", "{{base}}/invoices/overdue.csv", {
        headers: [{ name: "Accept", value: "text/csv" }],
      }),
    ],
  }),
  new RequestFile({
    path: CUSTOMERS,
    parseErrors: [],
    requests: [
      request(CUSTOMERS, 1, "Get customer", "GET", "{{base}}/customers/{{customerId}}"),
      request(CUSTOMERS, 6, "Create customer", "POST", "{{base}}/customers", {
        headers: [JSON_TYPE],
        body: '{ "name": "Acme GmbH", "currency": "EUR" }\n',
      }),
      request(
        CUSTOMERS,
        15,
        "Update billing address",
        "PUT",
        "{{base}}/customers/{{customerId}}/billing",
        {
          headers: [JSON_TYPE],
          body: '{ "city": "Berlin" }\n',
        }
      ),
    ],
  }),
  new RequestFile({
    path: WEBHOOKS,
    parseErrors: [],
    requests: ["Stripe paid", "Stripe failed", "Stripe refunded", "Retry", "Replay", "List"].map(
      (name, i) =>
        request(WEBHOOKS, 1 + i * 8, name, i === 5 ? "GET" : "POST", `{{base}}/webhooks/${i}`)
    ),
  }),
];

const VARIABLES: ReadonlyArray<ResolvedVariable> = [
  { name: "base", source: "env", masked: false, value: "http://localhost:4000", origin: "local" },
  { name: "$dotenv LEDGER_TOKEN", source: "dotenv", masked: true },
];

const SESSION = SessionId.make("s-overdue-totals");

export interface FixtureOptions {
  /** A Request opened with unsaved edits, as Q1 shows "Recalculate overdue". */
  readonly files?: ReadonlyArray<RequestFile>;
  readonly environments?: ReadonlyArray<string>;
  /** Sends already in the log, newest first, for `getSend`. */
  readonly sends?: ReadonlyArray<Send>;
}

const targetUrl = (target: RequestTarget, files: ReadonlyArray<RequestFile>) =>
  RequestTarget.match(target, {
    Saved: ({ ref }) =>
      files.find((f) => f.path === ref.file)?.requests.find((r) => r.name === ref.name),
    Inline: ({ request: r }) => r,
  });

const sendOf = (input: SendInput, files: ReadonlyArray<RequestFile>, n: number) => {
  const shown = targetUrl(input.target, files);

  const requestRef = RequestTarget.match(input.target, {
    Saved: ({ ref }) => ref,
    Inline: () => null,
  });

  const fields: Mutable<ConstructorParameters<typeof Send>[0]> = {
    id: `send-${n}`,
    checkout: "/Users/lucas/code/ledger.worktrees/overdue-totals",
    requestRef,
    method: shown?.method ?? "GET",
    url: (shown?.url ?? "").replace("{{base}}", "http://localhost:4000"),
    requestHeaders: shown?.headers ?? [],
    status: 200,
    statusText: "OK",
    responseHeaders: [JSON_TYPE],
    responseBody: '{ "recalculated": 214 }',
    responseTruncated: false,
    durationMs: 840,
    traceId: TraceId.make("4f1c9a2e4f1c9a2e4f1c9a2e4f1c9a2e"),
    startedAt: "2026-11-09T14:02:11.000Z",
    by: { kind: "user", sessionId: SESSION },
    outcome: "ok",
  };

  if (input.environment !== null) fields.environment = input.environment;

  return new Send(fields);
};

/** The Request as written at `line`, as the Daemon reports it after a save. */
const withLine = (saved: HttpRequest, line: number) => {
  const fields: Mutable<ConstructorParameters<typeof HttpRequest>[0]> = {
    file: saved.file,
    name: saved.name,
    method: saved.method,
    url: saved.url,
    headers: saved.headers,
    line,
  };

  if (saved.body !== undefined) fields.body = saved.body;

  if (saved.auth !== undefined) fields.auth = saved.auth;

  return new HttpRequest(fields);
};

/** A naive reading of `curl [-X M] URL [-H 'n: v']… [-d body]`, enough for previews. */
const parseCurl = (text: string): AdHocRequest | null => {
  const words = [...text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? ""
  );

  let method: string | null = null;
  let url = "";
  let body: string | undefined;
  const headers: Array<{ name: string; value: string }> = [];

  for (let i = 1; i < words.length; i++) {
    const word = words[i] ?? "";

    if (word === "-X") method = (words[++i] ?? "GET").toUpperCase();
    else if (word === "-H") {
      const [name = "", ...value] = (words[++i] ?? "").split(":");

      headers.push({ name: name.trim(), value: value.join(":").trim() });
    } else if (word === "-d" || word === "--data") body = words[++i];
    else if (!word.startsWith("-")) url = word;
  }

  if (url === "") return null;

  const parsed: Mutable<AdHocRequest> = {
    // SAFETY: previews only; a method outside the protocol's list is shown as typed.
    method: (method ?? (body === undefined ? "GET" : "POST")) as AdHocRequest["method"],
    url,
    headers,
  };

  if (body !== undefined) parsed.body = body;

  return parsed;
};

export const fixtureRequestsApi = (options: FixtureOptions = {}): RequestsApi => {
  let files = options.files ?? FILES;
  const environments = options.environments ?? ["dev", "staging"];
  const watchers = new Set<Watch<RequestsSnapshot>>();
  let sends = 0;
  let log = options.sends ?? [];
  const snapshot = (): RequestsSnapshot => ({ files, environments });

  return {
    watch: (_at, on) => {
      watchers.add(on);
      queueMicrotask(() => on.next(snapshot()));

      return () => watchers.delete(on);
    },
    save: async (_at, saved, previousName) => {
      const old = previousName ?? saved.name;
      const file = files.find((f) => f.path === saved.file);
      const at = file?.requests.findIndex((r) => r.name === old) ?? -1;
      const written = withLine(saved, at < 0 ? 1 : (file?.requests[at]?.line ?? 1));

      const requests =
        file === undefined
          ? [written]
          : at < 0
            ? [...file.requests, written]
            : file.requests.map((r, i) => (i === at ? written : r));

      const next = new RequestFile({ path: saved.file, requests, parseErrors: [] });

      files = file === undefined ? [...files, next] : files.map((f) => (f === file ? next : f));

      for (const on of watchers) on.next(snapshot());

      return { ok: true, value: next };
    },
    send: async (_at, input) => {
      const sent = sendOf(input, files, ++sends);

      log = [sent, ...log];

      return { ok: true, value: sent };
    },
    getSend: async (_at, lookup) => {
      const found = log.find((s) =>
        SendLookup.match(lookup, {
          ById: ({ id }) => s.id === id,
          ByTrace: ({ traceId }) => s.traceId === traceId,
        })
      );

      return found === undefined
        ? {
            ok: false,
            error: { code: "E-SEND-NOT-FOUND", message: "No such send", fix: "Send it again" },
          }
        : { ok: true, value: found };
    },
    variables: async () => ({ ok: true, value: VARIABLES }),
    parseCurl: async (_at, text) => {
      const parsed = parseCurl(text);

      return parsed === null
        ? {
            ok: false,
            error: {
              code: "E-CURL-PARSE",
              message: "No URL in that command",
              fix: "Paste the whole curl command",
            },
          }
        : { ok: true, value: parsed };
    },
    formatCurl: async (_at, input) => {
      const shown = targetUrl(input.target, files);

      return { ok: true, value: `curl -X ${shown?.method ?? "GET"} '${shown?.url ?? ""}'` };
    },
  };
};
