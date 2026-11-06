import { expect, test } from "bun:test";
import { Schema } from "effect";
import { decideDeviceAccess } from "./deviceGrants.ts";
import { Pairing } from "./extensions.ts";
import { decideAccess } from "./grants.ts";
import { PairingId, TurnId } from "./ids.ts";
import {
  CompareTraces,
  GetSpan,
  GetTrace,
  Profile,
  TraceComparison,
  TraceCompareSelector,
  TraceForwardTarget,
  TraceForwardUrl,
  WatchTraces,
} from "./traces.ts";

test("collector addresses exclude credentials and URL components that commonly carry tokens", () => {
  const accepts = Schema.is(TraceForwardUrl);

  for (const address of ["https://collector.example/v1/traces", "http://127.0.0.1:4318"])
    expect(accepts(address)).toBe(true);

  for (const address of [
    "https://user:secret@collector.example/v1/traces",
    "https://collector.example/v1/traces?token=secret",
    "https://collector.example/v1/traces#secret",
    "file:///private/collector",
    "not a URL",
  ])
    expect(accepts(address)).toBe(false);
});

test("forward targets cannot serialize a header value map from a Host-side target", () => {
  const hostTarget = {
    url: "https://collector.example/v1/traces",
    headerNames: ["Authorization", "X-Axiom-Dataset"],
    headers: { Authorization: "Bearer private-value", "X-Axiom-Dataset": "private-dataset" },
  };

  const wire = JSON.stringify(Schema.encodeSync(TraceForwardTarget)(hostTarget));

  expect(JSON.parse(wire)).toEqual({
    url: hostTarget.url,
    headerNames: ["Authorization", "X-Axiom-Dataset"],
  });
  expect(wire).not.toContain("private-value");
  expect(wire).not.toContain("private-dataset");
});

const extension = new Pairing({
  id: PairingId.make("all-grants"),
  name: "Extension",
  grant: ["read", "approve", "turn", "start", "voice"],
  createdAt: "2026-10-31T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
});

test.each([
  "traces.settings",
  "traces.setSettings",
  "profiles.watch",
  "profiles.get",
  "profiles.restartWithProfiling",
  "traces.compare",
])("%s stays local-Client-only even with every Extension Grant", (rpc) => {
  expect(decideAccess(extension, rpc, null)?.what).toBe(rpc);
  expect(decideDeviceAccess(rpc, null)?.what).toBe(rpc);
  expect(decideAccess(null, rpc, null)).toBeNull();
});

const recording = {
  id: "prof-1",
  command: "bun run dev",
  runtime: "bun",
  pid: 4242,
  turn: null,
  startedAt: "2026-10-31T14:02:11.000Z",
  durationMs: 12400,
  path: null,
  status: "completed",
};

test("a Profile from a Daemon without origin or service still decodes; unknown origins don't", () => {
  const decode = Schema.decodeUnknownSync(Profile);

  expect(decode(recording).origin).toBeUndefined();
  expect(decode({ ...recording, origin: "restart", service: "ledger-api" }).origin).toBe("restart");
  expect(() => decode({ ...recording, origin: "guess" })).toThrow();
});

test("compare wire round-trips legacy Turn pairs and additive Baseline/new-span evidence", () => {
  const before = TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("before") });
  const after = TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("after") });
  const codec = Schema.fromJsonString(TraceComparison);
  const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

  const legacy = JSON.stringify({
    a: before,
    b: after,
    routes: [
      {
        service: "api",
        route: "POST /invoices",
        before: { count: 5, p50Ms: 120, p95Ms: 130 },
        after: { count: 5, p50Ms: 840, p95Ms: 900 },
      },
    ],
  });

  expect(json(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(legacy)))).toEqual(
    json(legacy)
  );

  const evidence = {
    name: "query",
    service: "api",
    durationMs: 700,
    traceId: "1234567890abcdef1234567890abcdef",
    spanId: "1234567890abcdef",
  };

  const additive = JSON.stringify({
    a: TraceCompareSelector.cases.Baseline.make({}),
    b: after,
    routes: [
      {
        service: "api",
        route: "POST /invoices",
        before: { count: 2, p50Ms: null, p95Ms: null },
        after: { count: 5, p50Ms: null, p95Ms: null },
        slowestNew: evidence,
        partial: { before: 1, after: 0 },
      },
    ],
  });

  expect(json(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(additive)))).toEqual(
    json(additive)
  );
});

test("a Turn range is additive: its wire form names both ends, and Turn pairs decode as before", () => {
  const payload = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct(CompareTraces.payloadSchema.fields))
  );

  const wire = (a: string, b: string) => `{"sessionId":"s","a":${a},"b":${b}}`;

  expect(
    payload(wire('{"_tag":"Baseline"}', '{"_tag":"Turns","firstTurnId":"t4","lastTurnId":"t5"}')).b
  ).toEqual(
    TraceCompareSelector.cases.Turns.make({
      firstTurnId: TurnId.make("t4"),
      lastTurnId: TurnId.make("t5"),
    })
  );
  expect(() =>
    payload(wire('{"_tag":"Baseline"}', '{"_tag":"Turns","firstTurnId":"t4"}'))
  ).toThrow();
  expect(payload(wire('{"_tag":"Turn","turnId":"t3"}', '{"_tag":"Turn","turnId":"t4"}')).a).toEqual(
    TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("t3") })
  );
});

test("trace reads take an optional Self-Trace scope, and a payload from an older Client still decodes", () => {
  const watch = Schema.decodeUnknownSync(WatchTraces.payloadSchema);
  const get = Schema.decodeUnknownSync(GetTrace.payloadSchema);
  const span = Schema.decodeUnknownSync(GetSpan.payloadSchema);
  const trace = { sessionId: "s1", traceId: "abcd1234" };

  expect(Object.keys(watch({ sessionId: "s1" }))).toEqual(["sessionId"]);
  expect(Object.keys(get(trace))).toEqual(["sessionId", "traceId"]);
  expect(Object.keys(span({ ...trace, spanId: "ef012345" }))).toEqual([
    "sessionId",
    "traceId",
    "spanId",
  ]);
  expect(watch({ sessionId: "s1", scope: "self" }).scope).toBe("self");
  expect(get({ ...trace, scope: "self" }).scope).toBe("self");
  expect(span({ ...trace, spanId: "ef012345", scope: "self" }).scope).toBe("self");
  expect(() => watch({ sessionId: "s1", scope: "checkout" })).toThrow();
});
