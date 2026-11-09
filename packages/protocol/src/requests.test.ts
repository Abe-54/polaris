import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ApprovalDecision, ApprovalRequest } from "./domain.ts";
import { decideAccess } from "./grants.ts";
import { decideDeviceAccess } from "./deviceGrants.ts";
import { NotGranted, Pairing } from "./extensions.ts";
import { PairingId } from "./ids.ts";
import { RequestsRpcs, ResolvedVariable, Send } from "./requests.ts";

const approval = {
  id: "req-1",
  sessionId: "s-1",
  turnId: "t-1",
  kind: "tool",
  title: "Run a query",
  detail: null,
  options: [],
  openedAt: "2026-11-09T00:00:00Z",
};

test("an ApprovalRequest logged before Origin Approvals still decodes", () => {
  const decoded = Schema.decodeUnknownSync(ApprovalRequest)(approval);

  expect(decoded.origin).toBeUndefined();
});

test("an Origin Approval rides on the ApprovalRequest and survives the wire", () => {
  const origin = {
    origin: "https://api.example.com:443",
    variable: "baseUrl",
    environment: "staging",
    method: "POST",
    path: "/orders",
    write: true,
    tokenSource: { file: ".env", name: "API_TOKEN" },
  };

  const decoded = Schema.decodeUnknownSync(ApprovalRequest)({ ...approval, origin });

  expect(Schema.encodeSync(ApprovalRequest)(decoded).origin).toEqual(origin);
});

test("an Allow without originScope, as Clients before Requests send it, still decodes", () => {
  const wire: unknown = JSON.parse('{"_tag":"Allow","remember":true}');

  expect(Schema.decodeUnknownSync(ApprovalDecision)(wire)).toEqual(
    ApprovalDecision.cases.Allow.make({ remember: true })
  );
});

test("a masked variable never carries its value", () => {
  const decode = Schema.decodeUnknownSync(ResolvedVariable);

  expect(() =>
    decode({ name: "API_TOKEN", source: "dotenv", masked: true, value: "sk" })
  ).toThrow();
  expect(decode({ name: "API_TOKEN", source: "dotenv", masked: true })).toEqual({
    name: "API_TOKEN",
    source: "dotenv",
    masked: true,
  });
});

const send = {
  id: "send-1",
  checkout: "/repo",
  requestRef: null,
  method: "GET",
  url: "http://localhost:3000/health",
  requestHeaders: [],
  responseHeaders: [],
  responseTruncated: false,
  durationMs: 3,
  traceId: null,
  startedAt: "2026-11-09T00:00:00Z",
  outcome: "refused",
};

test.each([
  { kind: "agent", sessionId: "s-1", turn: "t-1" },
  { kind: "user", sessionId: "s-1" },
  { kind: "user" },
])("a Send by %o decodes", (by) => {
  expect(Schema.decodeUnknownSync(Send)({ ...send, by }).by).toEqual(by);
});

test("an agent Send without its Turn is refused", () => {
  expect(() =>
    Schema.decodeUnknownSync(Send)({ ...send, by: { kind: "agent", sessionId: "s-1" } })
  ).toThrow();
});

const extension = new Pairing({
  id: PairingId.make("extension"),
  name: "test",
  grant: ["read", "approve", "turn", "start", "voice"],
  createdAt: "2026-11-09T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
});

test.each([...RequestsRpcs.requests.keys()])(
  "%s is available to Desktop Clients and refused to Extensions and Linked Devices",
  (method) => {
    expect(decideAccess(null, method, null)).toBeNull();
    expect(decideAccess(extension, method, null)).toEqual(
      new NotGranted({ what: method, needed: null })
    );
    expect(decideDeviceAccess(method, null)).toEqual(
      new NotGranted({ what: method, needed: null })
    );
  }
);
