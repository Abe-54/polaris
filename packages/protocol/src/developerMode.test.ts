import { expect, test } from "bun:test";
import { Schema } from "effect";
import { DATA_FILE_SERVER, DataSource } from "./data.ts";
import { decideDeviceAccess } from "./deviceGrants.ts";
import { DeveloperMode } from "./developerMode.ts";
import { NotGranted, Pairing } from "./extensions.ts";
import { decideAccess } from "./grants.ts";
import { PairingId } from "./ids.ts";
import { SELF_TRACE_BATCH_BYTES, SelfTraceBatch } from "./selfTraces.ts";
import { readTraceContext, traceContextHeaders } from "./traceContext.ts";

const extension = new Pairing({
  id: PairingId.make("extension"),
  name: "test",
  grant: ["read", "approve", "turn", "start", "voice"],
  createdAt: "2026-10-30T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
});

const devModeRpcs = [
  "developerMode.get",
  "developerMode.set",
  "developerMode.setWorkspace",
  "developerMode.lease",
  "developerMode.watch",
  "traces.ingestSelf",
];

test.each(devModeRpcs)("%s is refused to Extensions", (rpc) => {
  expect(decideAccess(null, rpc, null)).toBeNull();
  expect(decideAccess(extension, rpc, null)).toEqual(new NotGranted({ what: rpc, needed: null }));
});

test.each([
  ["developerMode.get", true],
  ["developerMode.watch", true],
  ["traces.ingestSelf", true],
  ["developerMode.set", false],
  ["developerMode.setWorkspace", false],
  ["developerMode.lease", false],
  ["data.source.saveFile", false],
] as const)("a Linked Device may call %s: %p", (rpc, allowed) => {
  expect(decideDeviceAccess(rpc, null)).toEqual(
    allowed ? null : new NotGranted({ what: rpc, needed: null })
  );
});

const mode = {
  stored: false,
  leases: 1,
  effective: true,
  polarisWorkspaceId: "w1",
  polarisWorkspaceSource: "remote",
};

test("Developer Mode is effective exactly when stored or leased, and a Workspace has a source", () => {
  const decode = Schema.decodeUnknownSync(DeveloperMode);
  expect(decode(mode).effective).toBe(true);
  expect(() => decode({ ...mode, leases: 0 })).toThrow();
  expect(() => decode({ ...mode, polarisWorkspaceSource: null })).toThrow();
  expect(() => decode({ ...mode, polarisWorkspaceId: null })).toThrow();
});

const source = {
  id: "app",
  name: "app",
  engine: "postgres",
  locality: "local",
  host: "localhost",
  port: 5432,
  database: "app",
  foundIn: { kind: "manual" },
  access: "read",
  writes: "ask",
  label: { text: "", colour: "none" },
};

test("a Data Source has a path exactly when its engine is sqlite", () => {
  const decode = Schema.decodeUnknownSync(DataSource);
  const file = { ...source, ...DATA_FILE_SERVER, engine: "sqlite", path: "/work/app.db" };
  expect(decode(file).path).toBe("/work/app.db");
  expect(decode({ ...file, path: "C:\\work\\app.db" }).path).toBe("C:\\work\\app.db");
  expect(decode(source).path).toBeUndefined();
  expect(() => decode({ ...file, path: undefined })).toThrow();
  expect(() => decode({ ...source, path: "/work/app.db" })).toThrow();
  expect(() => decode({ ...file, path: "app.db" })).toThrow();
  expect(() => decode({ ...file, path: "/work/a\nb.db" })).toThrow();
});

const span = {
  traceId: "1234567890abcdef1234567890abcdef",
  id: "1234567890abcdef",
  parentId: null,
  name: "dispatch",
  kind: "client",
  status: "ok",
  statusMessage: "",
  traceState: "",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  attributes: {},
  resource: {},
  scope: { name: "polaris", version: "0.8.1", attributes: {} },
  events: [],
  links: [],
  droppedAttributes: 0,
  droppedEvents: 0,
  droppedLinks: 0,
};

test("a Self-Trace batch is refused past its encoded size cap", () => {
  const decode = Schema.decodeUnknownSync(SelfTraceBatch);
  expect(decode({ service: "polaris-mobile", spans: [span] }).spans).toHaveLength(1);
  const big = { ...span, attributes: { blob: "x".repeat(SELF_TRACE_BATCH_BYTES) } };
  expect(() => decode({ service: "polaris-mobile", spans: [big] })).toThrow();
  expect(() => decode({ service: "polaris-mobile", spans: [] })).toThrow();
});

const parent = "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01";

const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

test.each([
  ["no header", {}],
  ["an unknown version", { traceparent: `01${parent.slice(2)}` }],
  ["an all-zero trace id", { traceparent: `00-${"0".repeat(32)}-1234567890abcdef-01` }],
  [
    "an all-zero span id",
    { traceparent: `00-1234567890abcdef1234567890abcdef-${"0".repeat(16)}-01` },
  ],
  ["uppercase hex", { traceparent: parent.toUpperCase() }],
  ["trailing data", { traceparent: `${parent}-x` }],
])("a request with %s carries no trace context", (_, values) => {
  expect(readTraceContext(headers(values))).toBeNull();
});

test("a valid traceparent survives, and an invalid or oversized tracestate is dropped alone", () => {
  expect(
    readTraceContext(headers({ traceparent: parent, tracestate: "polaris=a1,vendor@x=b" }))
  ).toEqual({ traceparent: parent, tracestate: "polaris=a1,vendor@x=b" });
  expect(readTraceContext(headers({ traceparent: parent, tracestate: "no equals" }))).toEqual({
    traceparent: parent,
  });
  const long = Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(",");
  expect(readTraceContext(headers({ traceparent: parent, tracestate: long }))).toEqual({
    traceparent: parent,
  });
  expect(
    readTraceContext(headers({ traceparent: parent, tracestate: `k=${"v".repeat(600)}` }))
  ).toEqual({ traceparent: parent });
});

test("headers round-trip a context, and there are none without one", () => {
  const context = { traceparent: parent, tracestate: "polaris=a1" };
  const sent = new Map(traceContextHeaders(context));
  expect(readTraceContext((name) => sent.get(name))).toEqual(context);
  expect(traceContextHeaders(null)).toEqual([]);
});
