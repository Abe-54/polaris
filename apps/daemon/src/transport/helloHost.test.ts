import { describe, expect, test } from "bun:test";
import { type Capability, HostInfo, PROTOCOL_VERSION } from "@polaris/protocol";
import { Schema } from "effect";
import { helloHost } from "./hostInfo.ts";

const host = (platform: string) =>
  Schema.decodeUnknownSync(HostInfo)({
    hostId: "host-1",
    hostname: "desktop",
    platform,
    daemonVersion: "0.2.0",
    homeDir: "C:\\Users\\lucas",
    startedAt: "2026-10-16T00:00:00Z",
  });

describe("helloHost", () => {
  test.each<[string, string, ReadonlyArray<Capability>]>([
    [
      "a Client that decodes any platform of a windows-x64 Host",
      "windows-x64",
      ["host.any-platform"],
    ],
    ["an older Client of a Unix Host", "linux-arm64", []],
  ])("%s is told the Host as it is", (_, platform, capabilities) => {
    expect(helloHost(host(platform), capabilities)).toEqual({
      host: host(platform),
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  test("an older Client gets a newer protocol version, so it asks for an update", () => {
    const answer = helloHost(host("windows-x64"), []);

    expect(answer.protocolVersion).toBeGreaterThan(PROTOCOL_VERSION);
    expect(answer.host.platform).not.toBe("windows-x64");
    expect(answer.host.hostId).toBe(host("windows-x64").hostId);
  });
});
