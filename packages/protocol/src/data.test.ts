import { expect, test } from "bun:test";
import { decideAccess } from "./grants.ts";
import { decideDeviceAccess } from "./deviceGrants.ts";
import { NotGranted, Pairing } from "./extensions.ts";
import { PairingId } from "./ids.ts";

const extension = new Pairing({
  id: PairingId.make("extension"),
  name: "test",
  grant: ["read", "approve", "turn", "start", "voice"],
  createdAt: "2026-10-30T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
});

test.each([
  "data.sources.watch",
  "data.schemaDiff",
  "data.describe",
  "data.query",
  "data.queryLog.watch",
  "data.source.save",
  "data.source.saveFile",
  "data.source.remove",
  "data.source.label",
  "data.query.stream",
  "data.queryLog.page",
  "data.source.access",
])("%s is available to Desktop Clients and refused to Extensions and Linked Devices", (method) => {
  expect(decideAccess(null, method, null)).toBeNull();
  expect(decideAccess(extension, method, null)).toEqual(
    new NotGranted({ what: method, needed: null })
  );
  expect(decideDeviceAccess(method, null)).toEqual(new NotGranted({ what: method, needed: null }));
});
