import { expect, test } from "bun:test";
import { queryParams, urlPieces, variablesIn, withQueryParams } from "./url.ts";

test("the URL bar colours variables and dims the query, losing no text", () => {
  const url = "{{base}}/invoices/{{id}}?recalculate=true&at={{now}}";
  const pieces = urlPieces(url);

  expect(pieces).toEqual([
    { kind: "variable", text: "{{base}}" },
    { kind: "text", text: "/invoices/" },
    { kind: "variable", text: "{{id}}" },
    { kind: "query", text: "?recalculate=true&at=" },
    { kind: "variable", text: "{{now}}" },
  ]);
  expect(pieces.map((p) => p.text).join("")).toBe(url);
});

test("variables are named once each, braces and spaces dropped", () => {
  expect(variablesIn("{{ base }}/a/{{$dotenv TOKEN}}/{{base}}")).toEqual(["base", "$dotenv TOKEN"]);
});

test("Params reads the query undecoded and rewrites it in place", () => {
  const url = "{{base}}/invoices?status=open&flag&at={{now}}";

  expect(queryParams(url)).toEqual([
    { name: "status", value: "open" },
    { name: "flag", value: "" },
    { name: "at", value: "{{now}}" },
  ]);
  expect(withQueryParams(url, [{ name: "status", value: "paid" }])).toBe(
    "{{base}}/invoices?status=paid"
  );
  expect(withQueryParams(url, [{ name: "", value: "" }])).toBe("{{base}}/invoices");
  expect(withQueryParams("/a", [{ name: "q", value: "1" }])).toBe("/a?q=1");
});
