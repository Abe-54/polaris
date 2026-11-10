import { expect } from "bun:test";
import { posixTest } from "../../platform/testing.ts";
import { tempDir } from "../../platform/tempDir.testing.ts";
import { bunRuntime, installSimulatorTools } from "./install.ts";
import { AGENT_DEVICE_VERSION } from "./pin.ts";

const test = posixTest("the Simulator never runs on Windows");

const run = (script: string, args: ReadonlyArray<string>) => {
  const runtime = bunRuntime();

  const proc = Bun.spawnSync([...runtime.argv, script, ...args], {
    env: { ...process.env, ...runtime.env },
  });

  return { code: proc.exitCode, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
};

// Real network: the pinned set from the npm registry, checked against the committed lockfile.
test("the pinned hub and agent-device install from npm and run under the Daemon's Bun", async () => {
  const installed = await installSimulatorTools({ root: tempDir("sim-tools-npm-") });

  const hub = run(installed.hub, ["--help"]);
  expect(hub.code).toBe(0);
  expect(hub.out).toContain("--require-token");
  expect(run(installed.agentDevice, ["--version"]).out.trim()).toBe(AGENT_DEVICE_VERSION);
}, 120_000);
