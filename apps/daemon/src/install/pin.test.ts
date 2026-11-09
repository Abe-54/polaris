import { describe, expect, test } from "bun:test";
import { runtimePlatformOf } from "../platform/index.ts";
import { AGENT_BROWSER_ASSETS } from "./agentBrowser/pin.ts";
import { AGENT_DESKTOP_BUILDS } from "./agentDesktop/pin.ts";

const host = (os: string, arch: string) =>
  runtimePlatformOf({ os, arch, libc: os === "linux" ? "glibc" : "none" });

const EVERY = ["darwin", "linux", "win32"].flatMap((os) =>
  ["arm64", "x64"].map((arch) => host(os, arch))
);

// The pins are keyed by what `runtimePlatform()` answers on each Host, not by `process.platform`.
describe("pins", () => {
  test.each(EVERY)("agent-desktop has a build for %s", (platform) => {
    expect(Object.keys(AGENT_DESKTOP_BUILDS)).toContain(platform);
  });

  test.each(EVERY.filter((platform) => platform !== host("win32", "arm64")))(
    "agent-browser has a build for %s",
    (platform) => {
      expect(Object.keys(AGENT_BROWSER_ASSETS)).toContain(platform);
    }
  );
});
