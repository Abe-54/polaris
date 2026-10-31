/** What the map counts as a call, from small traces (RPU's P6 findings, ENG-666). */
import { expect, test } from "bun:test";
import { FIXTURE_TURNS } from "../../preview/fixtures.ts";
import { callerWords, servicePanel, startedWords } from "./index.ts";
import { edgeLines, mapOfSpans, spanAt as at } from "./spans.testing.ts";

test("finding P6-2: a service named api calling api.stripe.com draws the call", () => {
  const own = mapOfSpans([
    at(1, null, "api", "server"),
    at(2, 1, "api", "client", { "url.full": "https://api.stripe.com/v1/charges" }),
  ]);

  const other = mapOfSpans([
    at(1, null, "web", "server"),
    at(2, 1, "web", "client", { "url.full": "https://api.stripe.com/v1/charges" }),
    at(3, 1, "web", "client", { "url.full": "http://api.internal/users" }),
    at(4, 3, "api", "server"),
  ]);

  expect(edgeLines(own)).toEqual(["api → api.stripe.com ×1"]);
  expect(edgeLines(other)).toEqual(["web → api ×1", "web → api.stripe.com ×1"]);
});

test("finding P6-3: one call through two nested client spans is one call, no phantom host", () => {
  const nested = (url: string) =>
    mapOfSpans([
      at(1, null, "ledger-api", "server"),
      at(2, 1, "ledger-api", "client", { "url.full": url }),
      at(3, 2, "ledger-api", "client", { "url.full": url }),
      at(4, 3, "fx-rates", "server"),
    ]);

  const http = nested("http://10.0.4.12:8080/rates");

  const orm = mapOfSpans([
    at(1, null, "ledger-api", "server"),
    at(2, 1, "ledger-api", "client", { "db.system.name": "postgresql" }),
    at(3, 2, "ledger-api", "client", { "db.system.name": "postgresql" }),
  ]);

  expect(edgeLines(nested("http://fx-rates.internal/rates"))).toEqual(["ledger-api → fx-rates ×1"]);
  expect(edgeLines(http)).toEqual(["ledger-api → fx-rates ×1"]);
  expect(http.nodes.map((n) => n.name)).toEqual(["ledger-api", "fx-rates"]);
  expect(edgeLines(orm)).toEqual(["ledger-api → postgresql ×1"]);
});

/** Twelve iterations under the root, each `wrapped` in an internal span of its own or not. */
const twelve = (root: "internal" | "server", wrapped: boolean) =>
  mapOfSpans([
    at(1, null, "ledger-tests", root),
    ...Array.from({ length: 12 }, (_, i) => {
      const n = 10 + i * 3;
      const parent = wrapped ? n : 1;

      return [
        ...(wrapped ? [at(n, 1, "ledger-tests", "internal")] : []),
        at(n + 1, parent, "ledger-tests", "client", { "http.request.method": "GET" }),
        at(n + 2, n + 1, "ledger-api", "server"),
      ];
    }).flat(),
  ]);

test.each([
  ["twelve tests that each call the API once are not", "internal", true, false],
  ["a script calling the API twelve times from one span is", "internal", false, true],
  ["a request calling it twelve times, each in its own span, is", "server", true, true],
] as const)("finding P6-5: %s an N+1", (_, root, wrapped, flagged) => {
  const panel = servicePanel(twelve(root, wrapped), "ledger-tests");

  expect(panel?.calls.map((c) => [c.name, c.calls, c.nPlusOne])).toEqual([
    ["ledger-api", 12, flagged],
  ]);
  expect(panel?.nPlusOne).toHaveLength(flagged ? 1 : 0);
});

test.each([
  ["a run its Turn launched", FIXTURE_TURNS[11], "turn 11", "Started by the agent"],
  ["a run during a Turn", null, "during turn 11", "Started during a turn"],
] as const)("finding P6-8: %s says so", (_, launchedTurn, turn, legend) => {
  const map = mapOfSpans([at(1, null, "settle-job", "internal")], {
    turn: FIXTURE_TURNS[11],
    launchedTurn,
  });

  expect(callerWords(map.caller)).toEqual([turn]);
  expect(startedWords(map.caller)).toBe(legend);
});

test("finding P6-8: a run between Turns says so", () => {
  const map = mapOfSpans([at(1, null, "settle-job", "internal")]);

  expect([...callerWords(map.caller), startedWords(map.caller)]).toEqual([
    "between turns",
    "Started between turns",
  ]);
});
