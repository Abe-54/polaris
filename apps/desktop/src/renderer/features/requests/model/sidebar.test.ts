import { expect, test } from "bun:test";
import { HttpRequest, RequestFile } from "@polaris/protocol";
import { fileGroups, requestCount } from "./sidebar.ts";

const request = (file: string, name: string, method: "GET" | "POST", url: string) =>
  new HttpRequest({ file, name, method, url, headers: [] });

const recalculate = request(
  "http/invoices.http",
  "Recalculate overdue",
  "POST",
  "{{base}}/invoices/overdue"
);

const files = [
  new RequestFile({
    path: "http/invoices.http",
    requests: [
      request("http/invoices.http", "List overdue", "GET", "{{base}}/invoices/overdue"),
      recalculate,
    ],
    parseErrors: [{ line: 30, message: "no URL" }],
  }),
  new RequestFile({
    path: "http/customers.http",
    requests: [request("http/customers.http", "Get customer", "GET", "{{base}}/customers/1")],
    parseErrors: [],
  }),
];

test("files are listed by path with every Request", () => {
  const groups = fileGroups(files, "");

  expect(groups.map((g) => g.path)).toEqual(["http/customers.http", "http/invoices.http"]);
  expect(groups[1]?.parseErrors).toBe(1);
  expect(requestCount(files)).toBe(3);
});

test("the filter keeps files with a match, holding only matching Requests", () => {
  expect(fileGroups(files, "post overdue")).toEqual([
    {
      path: "http/invoices.http",
      requests: [recalculate],
      parseErrors: 1,
    },
  ]);
  expect(fileGroups(files, "customers")).toHaveLength(1);
  expect(fileGroups(files, "nothing")).toEqual([]);
});
