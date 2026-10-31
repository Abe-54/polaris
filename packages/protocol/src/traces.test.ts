import { expect, test } from "bun:test";
import { Schema } from "effect";
import { CapabilityList } from "./capabilities.ts";
import { decideDeviceAccess } from "./deviceGrants.ts";
import { Pairing } from "./extensions.ts";
import { decideAccess } from "./grants.ts";
import { PairingId } from "./ids.ts";
import {
  Profile,
  TraceComparison,
  TraceCompareSelector,
  TraceForwardTarget,
  TraceForwardUrl,
} from "./traces.ts";
import { TurnId } from "./ids.ts";

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

test("new Traces capabilities survive negotiation independently of phase 1", () => {
  expect(
    Schema.decodeUnknownSync(CapabilityList)([
      "traces.settings",
      "traces.profiles",
      "traces.compare",
      "traces.future",
    ])
  ).toEqual(["traces.settings", "traces.profiles", "traces.compare"]);
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
