import { expect, test } from "bun:test";
import { Schema } from "effect";
import { CapabilityList } from "./capabilities.ts";
import { decideDeviceAccess } from "./deviceGrants.ts";
import { Pairing } from "./extensions.ts";
import { decideAccess } from "./grants.ts";
import { PairingId } from "./ids.ts";
import { TraceForwardTarget, TraceForwardUrl } from "./traces.ts";

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
