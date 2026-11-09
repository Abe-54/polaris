import { describe, expect, test } from "bun:test";
import { runtimePlatform } from "../../platform/index.ts";
import { tempDir } from "../../platform/tempDir.testing.ts";
import { installAgentDesktop, installedOnDisk } from "./install.ts";
import { AGENT_DESKTOP_BUILDS, AGENT_DESKTOP_VERSION } from "./pin.ts";

const supported = Object.hasOwn(AGENT_DESKTOP_BUILDS, runtimePlatform());

// Real network: the pinned release from GitHub, checked against the pin and run on this Host.
describe.skipIf(!supported)("the pinned agent-desktop release", () => {
  test("downloads, matches its pin and reports the pinned version", async () => {
    const options = { root: tempDir("ad-real-"), platform: runtimePlatform() };

    const { binary } = await installAgentDesktop(options);
    const run = Bun.spawnSync([binary, "--version"]);

    expect(run.stdout.toString().trim()).toBe(`agent-desktop ${AGENT_DESKTOP_VERSION}`);
    expect(await installedOnDisk(options)).toEqual({ binary });
  }, 120_000);
});
