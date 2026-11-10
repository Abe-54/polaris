import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stockElectronBinary } from "../lib/electron.ts";
import { fuseMismatches, fusesHook } from "./fuses.ts";

const root = mkdtempSync(join(tmpdir(), "polaris-fuses-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(process.platform !== "darwin")(
  "the packaging hook closes Node mode on a real Electron bundle and keeps it loadable",
  async () => {
    const app = join(root, "Polaris.app");
    // ditto keeps the framework's symlinks and signatures as packager's copy does.
    const stock = join(dirname(stockElectronBinary()), "../..");

    expect(spawnSync("ditto", [stock, app]).status).toBe(0);
    expect(await fuseMismatches(app)).toContain("RunAsNode: ENABLE");

    await fusesHook({ buildPath: root, platform: "darwin", arch: "arm64", electronVersion: "" });

    expect(await fuseMismatches(app)).toEqual([]);

    const framework = join(app, "Contents/Frameworks/Electron Framework.framework");
    const verify = spawnSync("codesign", ["--verify", framework]);

    expect(verify.stderr.toString()).toBe("");
    expect(verify.status).toBe(0);
  },
  60_000
);
