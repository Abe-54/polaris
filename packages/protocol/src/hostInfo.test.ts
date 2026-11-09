import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { HostInfo, LEGACY_PLATFORMS } from "./domain.ts";
import { HostId, Timestamp } from "./ids.ts";

const base = {
  hostId: "host-1",
  hostname: "pi",
  platform: "linux-arm64",
  daemonVersion: "0.1.0",
  homeDir: "/home/pi",
  startedAt: "2026-10-13T00:00:00Z",
};

/** `HostInfo` as Clients before 0.2.0 declared it: no `libc`, and three platforms. */
const OlderHostInfo = Schema.Struct({
  hostId: HostId,
  hostname: Schema.String,
  platform: Schema.Literals(LEGACY_PLATFORMS),
  daemonVersion: Schema.String,
  homeDir: Schema.String,
  startedAt: Timestamp,
});

describe("HostInfo.libc on the wire", () => {
  test("a new Client decodes an older Daemon's HostInfo, which has no libc", () => {
    const info = Schema.decodeUnknownSync(HostInfo)(base);

    expect(info.libc).toBeUndefined();
  });

  test("this Client decodes a C library newer than itself", () => {
    const info = Schema.decodeUnknownSync(HostInfo)({ ...base, libc: "bionic" });

    expect(info.libc).toBe("bionic");
  });
});

describe("HostInfo.platform on the wire", () => {
  test("this Client decodes a Host on a platform newer than itself", () => {
    const info = Schema.decodeUnknownSync(HostInfo)({ ...base, platform: "windows-arm64" });

    expect(info.platform).toBe("windows-arm64");
  });
});

describe("HostInfo fields an older Client doesn't know", () => {
  const stop = { reason: "upgrade", fromVersion: "0.2.0-dev.1", at: "2026-10-16T00:00:00Z" };

  test.each([
    ["libc", { libc: "glibc" }],
    ["previousStop", { previousStop: stop }],
  ])("an older Client decodes a new Daemon's HostInfo and ignores %s", (_, added) => {
    const encoded = Schema.encodeSync(HostInfo)(
      Schema.decodeUnknownSync(HostInfo)({ ...base, ...added })
    );

    expect(Schema.decodeUnknownSync(OlderHostInfo)(encoded)).toMatchObject({
      platform: "linux-arm64",
      daemonVersion: "0.1.0",
    });
  });

  test("this Client decodes a stop reason newer than itself", () => {
    const info = Schema.decodeUnknownSync(HostInfo)({
      ...base,
      previousStop: { ...stop, reason: "maintenance" },
    });

    expect(info.previousStop?.reason).toBe("maintenance");
  });
});
