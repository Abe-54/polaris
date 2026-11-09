import { expect, test } from "bun:test";
import { HttpRequest, RequestAuth, RequestTarget } from "@polaris/protocol";
import {
  bodyLanguage,
  draftFromAdHoc,
  draftOf,
  isDirty,
  setsTraceparent,
  targetOf,
  toHttpRequest,
} from "./draft.ts";

const BEARER = RequestAuth.cases.Bearer.make({ token: "{{$dotenv LEDGER_TOKEN}}" });

const saved = new HttpRequest({
  file: "http/invoices.http",
  name: "Recalculate overdue",
  method: "POST",
  url: "{{base}}/invoices/overdue",
  headers: [{ name: "Content-Type", value: "application/json" }],
  body: '{ "asOf": "{{$isoTimestamp}}" }',
  auth: BEARER,
  line: 14,
});

test("an untouched draft is clean and sends the saved Request by ref", () => {
  const draft = draftOf(saved);

  expect(isDirty(draft, saved)).toBe(false);
  expect(targetOf(draft, saved)).toEqual(
    RequestTarget.cases.Saved.make({
      ref: { file: "http/invoices.http", name: "Recalculate overdue" },
    })
  );
});

test.each([
  ["url", { url: "{{base}}/invoices" }],
  ["method", { method: "PUT" as const }],
  ["body", { body: "{}" }],
  ["headers", { headers: [] }],
  ["auth", { auth: RequestAuth.cases.Basic.make({ user: "a", password: "b" }) }],
  ["name", { name: "Recalculate" }],
])("an edited %s is unsaved and sent as written, not as the file has it", (_field, change) => {
  const draft = { ...draftOf(saved), ...change };

  expect(isDirty(draft, saved)).toBe(true);
  expect(RequestTarget.guards.Inline(targetOf(draft, saved))).toBe(true);
});

test("the inline send carries the edits and drops blank header rows", () => {
  const draft = {
    ...draftOf(saved),
    url: "{{base}}/x",
    headers: [...saved.headers, { name: " ", value: "" }],
  };

  expect(targetOf(draft, saved)).toEqual(
    RequestTarget.cases.Inline.make({
      name: "Recalculate overdue",
      request: {
        method: "POST",
        url: "{{base}}/x",
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: '{ "asOf": "{{$isoTimestamp}}" }',
        auth: BEARER,
      },
    })
  );
});

test("a draft not in the file is always unsaved", () => {
  expect(isDirty(draftOf(saved), undefined)).toBe(true);
});

test("saving writes no empty body or auth", () => {
  const request = toHttpRequest({ ...draftOf(saved), body: "", auth: null, name: " Ping " });

  expect(request.body).toBeUndefined();
  expect(request.auth).toBeUndefined();
  expect(request.name).toBe("Ping");
});

test("a pasted curl becomes a new draft named for its method and path, never a taken name", () => {
  const draft = draftFromAdHoc(
    { method: "GET", url: "https://api.example.com/v1/users?page=2", headers: [] },
    new Set(["GET /v1/users"])
  );

  expect(draft.name).toBe("GET /v1/users 2");
  expect(draft.file).toBe("http/requests.http");
  expect(draft.line).toBeNull();
});

test("traceparent is the Request's own only when it sets one", () => {
  expect(setsTraceparent(saved.headers)).toBe(false);
  expect(setsTraceparent([{ name: "TraceParent", value: "00-…" }])).toBe(true);
});

test.each([
  [[{ name: "content-type", value: "application/vnd.api+json" }], "", "json"],
  [[], "  [1, 2]", "json"],
  [[], "<a/>", "xml"],
  [[{ name: "Content-Type", value: "application/x-www-form-urlencoded" }], "a=1", "form"],
  [[], "hello", "text"],
] as const)("the body is coloured as %j %j → %s", (headers, body, language) => {
  expect(bodyLanguage({ headers, body })).toBe(language);
});
