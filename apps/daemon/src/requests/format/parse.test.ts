import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequest, RequestAuth } from "@polaris/protocol";
import { Result, Schema } from "effect";
import { editRequest, parse, parseDocument, serialize } from "./index.ts";

const fixture = (path: string) => readFileSync(join(import.meta.dir, "fixtures", path), "utf8");

const INVOICES = fixture("ledger/http/invoices.http");

const JETBRAINS = fixture("jetbrains/requests.http");

const encode = Schema.encodeSync(HttpRequest);

/** A copy of `request` with `changes`, built through its Schema. */
const changed = (request: HttpRequest, changes: Partial<typeof HttpRequest.Encoded>) =>
  new HttpRequest({ ...encode(request), ...changes });

/** What a Request says, without where it sits in its file. */
const asWritten = ({ name, method, url, headers, body, auth }: HttpRequest) => ({
  name,
  method,
  url,
  headers,
  body,
  auth,
});

const summary = (text: string, path: string) =>
  parse(text, path).requests.map((request) => [request.name, request.method, request.url]);

test("the Q1 mockup's invoices.http parses into its five requests", () => {
  const file = parse(INVOICES, "http/invoices.http");

  expect(file.parseErrors).toEqual([]);
  expect(summary(INVOICES, "http/invoices.http")).toEqual([
    ["List overdue", "GET", "{{base}}/invoices/overdue?tenant={{tenant}}"],
    ["Recalculate overdue", "POST", "{{base}}/invoices/overdue?recalculate=true"],
    ["Mark paid", "PATCH", "{{base}}/invoices/inv_2041"],
    ["Void invoice", "DELETE", "{{base}}/invoices/inv_2041"],
    [
      "Export overdue as CSV",
      "GET",
      "{{base}}/invoices/overdue.csv?tenant={{tenant}}&from=2026-10-01",
    ],
  ]);

  const recalculate = file.requests[1]!;

  expect(recalculate.line).toBe(14);
  expect(recalculate.headers.map((header) => header.name)).toEqual([
    "Content-Type",
    "Accept",
    "X-Tenant",
  ]);
  expect(recalculate.auth).toEqual(
    RequestAuth.cases.Bearer.make({ token: "{{$dotenv LEDGER_TOKEN}}" })
  );
  expect(recalculate.body).toBe(
    '{\n  "customerId": "cus_8f2a",\n  "asOf": "{{$isoTimestamp}}",\n  "currency": "EUR",\n  "includeDisputed": false\n}'
  );
  expect(file.requests[4]?.auth).toEqual(
    RequestAuth.cases.Basic.make({
      user: "{{admin}}",
      password: "{{$dotenv LEDGER_ADMIN_PASSWORD}}",
    })
  );
});

test("file-level @vars are collected with their lines", () => {
  expect(parseDocument(INVOICES, "http/invoices.http").variables).toEqual([
    { name: "tenant", value: "acme", line: 2 },
    { name: "currency", value: "EUR", line: 3 },
    { name: "customer", value: "cus_8f2a", line: 4 },
  ]);
});

test("a JetBrains sample parses, with handlers, redirects and response references out of the body", () => {
  const file = parse(JETBRAINS, "requests.http");

  expect(file.parseErrors).toEqual([]);
  expect(file.requests.map((request) => [request.name, request.method, request.body])).toEqual([
    ["GET request with a header", "GET", undefined],
    ["POST request with a JSON body from a file", "POST", "< ./payload.json"],
    ["Login", "POST", "username={{username}}&password={{password}}"],
    ["Authorized request", "GET", undefined],
  ]);
  expect(file.requests[3]?.auth).toEqual(RequestAuth.cases.Bearer.make({ token: "{{token}}" }));
});

test("problems become parse errors with their lines, and the rest still parses", () => {
  const text = [
    "### Trace it",
    "TRACE https://example.test/",
    "",
    "### Bad header",
    "GET https://example.test/a",
    "not a header line",
    "",
    "### Empty",
    "",
    "### Twice",
    "GET https://example.test/1",
    "",
    "### Twice",
    "GET https://example.test/2",
  ].join("\n");

  const file = parse(text, "bad.http");

  expect(file.parseErrors).toEqual([
    {
      line: 2,
      message: "Unsupported method TRACE: use GET, HEAD, OPTIONS, POST, PUT, PATCH or DELETE",
    },
    { line: 6, message: "Expected a header (Name: value), or a blank line before the body" },
    { line: 8, message: "This request has no request line" },
    { line: 14, message: 'Another request in this file is named "Twice"' },
  ]);
  expect(file.requests.map((request) => request.name)).toEqual([
    "Bad header",
    "Twice",
    "Twice (2)",
  ]);
});

test("unnamed requests get unique names from their method and path, and a bare URL means GET", () => {
  const text = "https://api.test/users?page=1\n\n###\n{{base}}/users\n\n###\nDELETE /users/1\n";

  expect(summary(text, "x.rest")).toEqual([
    ["GET /users", "GET", "https://api.test/users?page=1"],
    ["GET /users (2)", "GET", "{{base}}/users"],
    ["DELETE /users/1", "DELETE", "/users/1"],
  ]);
});

test("serialize round-trips a file's requests", () => {
  for (const [text, path] of [
    [INVOICES, "http/invoices.http"],
    [JETBRAINS, "requests.http"],
  ] as const) {
    const file = parse(text, path);
    const again = parse(serialize(file), path);

    expect(again.parseErrors).toEqual([]);
    expect(again.requests.map(asWritten)).toEqual(file.requests.map(asWritten));
  }
});

const edited = (text: string, request: HttpRequest, previousName?: string) => {
  const result = editRequest(text, "http/invoices.http", request, previousName);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

/** The text outside the edited request: everything before and after its byte range. */
const outside = (text: string, name: string) => {
  const block = parseDocument(text, "http/invoices.http").blocks.find(
    (item) => item.request.name === name
  )!;

  return [text.slice(0, block.contentStart), text.slice(block.contentEnd)];
};

test("an in-place edit rewrites one request and leaves every other byte as it was", () => {
  const original = parse(INVOICES, "http/invoices.http").requests[1]!;

  const update = changed(original, {
    url: "{{base}}/invoices/overdue?recalculate=false",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: '{ "customerId": "cus_9000" }',
  });

  const text = edited(INVOICES, update);
  const [before, after] = outside(INVOICES, "Recalculate overdue");

  expect(text.startsWith(before!)).toBe(true);
  expect(text.endsWith(after!)).toBe(true);
  expect(text).toContain("// Safe to repeat: it is idempotent per customer and day.\n");

  const reparsed = parse(text, "http/invoices.http");
  expect(reparsed.requests[1]).toMatchObject({
    url: update.url,
    headers: update.headers,
    body: update.body,
    auth: original.auth,
  });

  const others = (requests: ReadonlyArray<HttpRequest>) =>
    requests.flatMap((request, index) => (index === 1 ? [] : [asWritten(request)]));

  expect(others(reparsed.requests)).toEqual(others(parse(INVOICES, "http/invoices.http").requests));
});

test("renaming keeps the name where it was written: ### name or # @name", () => {
  const requests = parse(INVOICES, "http/invoices.http").requests;

  const byName = edited(INVOICES, changed(requests[0]!, { name: "Overdue" }), "List overdue");

  const byTag = edited(INVOICES, changed(requests[2]!, { name: "Settle" }), "Mark paid");

  expect(byName.replace("### Overdue\n", "### List overdue\n")).toBe(INVOICES);
  expect(byTag.replace("# @name Settle\n", "# @name Mark paid\n")).toBe(INVOICES);
});

test("a CRLF file keeps CRLF in the edited request", () => {
  const crlf = INVOICES.replaceAll("\n", "\r\n");
  const request = parse(crlf, "http/invoices.http").requests[3]!;

  const text = edited(crlf, changed(request, { headers: [{ name: "X-Reason", value: "dup" }] }));

  expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  expect(parse(text, "http/invoices.http").requests[3]?.headers).toEqual([
    { name: "X-Reason", value: "dup" },
  ]);
});

test("a new name is appended; a rename onto another request's name conflicts; a missing previous name is not found", () => {
  const request = new HttpRequest({
    file: "http/invoices.http",
    name: "Health",
    method: "GET",
    url: "{{base}}/health",
    headers: [],
  });

  const appended = edited(INVOICES, request);

  expect(appended.startsWith(INVOICES)).toBe(true);
  expect(appended.slice(INVOICES.length)).toBe("\n### Health\nGET {{base}}/health\n");

  const conflict = editRequest(
    INVOICES,
    "http/invoices.http",
    changed(request, { name: "Mark paid" }),
    "Void invoice"
  );

  const missing = editRequest(INVOICES, "http/invoices.http", request, "Gone");

  expect(Result.isFailure(conflict) && conflict.failure.code).toBe("E-REQUEST-CONFLICT");
  expect(Result.isFailure(missing) && missing.failure.code).toBe("E-REQUEST-NOT-FOUND");
});

test("naming an unnamed request in the first block adds a # @name line above it", () => {
  const text = "GET https://api.test/a\n\n### B\nGET https://api.test/b\n";
  const request = parse(text, "x.http").requests[0]!;
  const out = edited(text, changed(request, { name: "A" }), request.name);

  expect(out).toBe("# @name A\nGET https://api.test/a\n\n### B\nGET https://api.test/b\n");
});
