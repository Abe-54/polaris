import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSimulatorTools } from "../install/simulator/install.ts";
import { AGENT_DEVICE_VERSION } from "../install/simulator/pin.ts";
import {
  type BunRuntime,
  bunRuntimeSource,
  ownBun,
  runsAsBun,
} from "../install/simulator/runtime.ts";
import { DAEMON_BUNDLE } from "./bundle.ts";
import {
  binaryOf,
  buildDaemon,
  DARWIN_PLATFORM,
  onDarwinArm64,
  runIn,
  signHardened,
  sipEnabled,
} from "./daemonBuild.testing.ts";
import { openRoutes, sealRuntime } from "./sealedRuntime.ts";

const dir = mkdtempSync(join(tmpdir(), "polaris-sealed-"));

const EVERY_ROUTE = [
  "BUN_BE_BUN",
  "BUN_OPTIONS --preload",
  "BUN_OPTIONS --require",
  "BUN_OPTIONS --import",
  "BUN_INSPECT",
];

const run = (argv: ReadonlyArray<string>, env?: Record<string, string | undefined>) =>
  runIn(dir, argv, env);

/** A sealed runtime is only a darwin release build's, and only darwin-arm64 ships. */
describe.skipIf(!onDarwinArm64)("a darwin release Daemon's Bun runtime is sealed", () => {
  let release = "";
  let dev = "";

  beforeAll(async () => {
    [release, dev] = await Promise.all([
      buildDaemon(dir, "release", ["--release"]),
      buildDaemon(dir, "dev", []),
    ]);
  }, 300_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("no variable of Bun's makes it run a script, though each does in a dev build", async () => {
    const options = { command: ["version"], names: "bun" } as const;

    expect(await openRoutes(binaryOf(release), options)).toEqual([]);
    expect(await openRoutes(binaryOf(dev), { ...options, timeoutMs: 3000 })).toEqual(EVERY_ROUTE);
  }, 120_000);

  test("with BUN_BE_BUN=1 and a script it is still the Daemon's command line", async () => {
    const marker = join(dir, "be-bun-ran");
    const script = join(dir, "be-bun.js");
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\n`);

    const ran = await run([binaryOf(release), script], { BUN_BE_BUN: "1", HOME: dir });

    expect(existsSync(marker)).toBe(false);
    expect(ran.stderr).toStartWith("usage: polaris <serve|");
    expect(ran.code).toBe(2);
  }, 60_000);

  test.skipIf(!sipEnabled)(
    "signed as a release is, the renamed variables cannot be set either",
    async () => {
      const options = { command: ["version"], names: "sealed" } as const;
      const hardened = join(dir, "hardened", DAEMON_BUNDLE);
      cpSync(release, hardened, { recursive: true });

      // The release signer's own entitlements: dyld keeps DYLD_ variables if one ever allows them.
      const signed = await signHardened(dir, hardened);

      expect(signed.code).toBe(0);
      expect(await openRoutes(binaryOf(hardened), options)).toEqual([]);
      // Without the hardened runtime they can: the seal protects a release, not this build.
      expect(await openRoutes(binaryOf(release), { ...options, timeoutMs: 3000 })).toEqual(
        EVERY_ROUTE
      );
    },
    120_000
  );

  // Real network: Oven's pinned Bun from GitHub, then the pinned tools from npm (ENG-829).
  test("the Simulator's tools install and run through Oven's Bun, which the sealed Daemon is not", async () => {
    const sealed = binaryOf(release);
    const root = join(dir, "tools");

    const bun = bunRuntimeSource({
      root: join(root, "bun"),
      platform: DARWIN_PLATFORM,
      executable: sealed,
    });

    const tools = await installSimulatorTools({ root: join(root, "simulator"), bun });

    const runAs = (bun: BunRuntime, script: string, flag: string) =>
      run([bun.program, script, flag], { ...process.env, ...bun.env });

    const hub = await runAs(tools.bun, tools.hub, "--help");
    const agentDevice = await runAs(tools.bun, tools.agentDevice, "--version");
    // What the Simulator did before: the sealed Daemon asked to be Bun.
    const asDaemon = await runAs(ownBun(sealed), tools.hub, "--help");

    expect(await runsAsBun(sealed)).toBe(false);
    expect(await runsAsBun(binaryOf(dev))).toBe(true);
    expect(tools.bun.program).toStartWith(join(root, "bun"));
    expect(hub.code).toBe(0);
    expect(hub.stdout + hub.stderr).toContain("--require-token");
    expect(agentDevice.stdout.trim()).toBe(AGENT_DEVICE_VERSION);
    expect(asDaemon.code).toBe(2);
    expect(asDaemon.stderr).toStartWith("usage: polaris <serve|");
  }, 300_000);

  test("sealing refuses a runtime where a variable's name is not where it was", () => {
    const copy = join(dir, "polaris-copy");
    cpSync(binaryOf(release), copy);
    const before = Bun.hash(readFileSync(copy));

    // Already sealed, so BUN_BE_BUN is no longer in it: as after a Bun upgrade that moved it.
    expect(() => sealRuntime(copy)).toThrow(
      /BUN_BE_BUN stands 0 times in the Bun runtime, expected 1/
    );
    expect(Bun.hash(readFileSync(copy))).toBe(before);
  }, 60_000);
});
