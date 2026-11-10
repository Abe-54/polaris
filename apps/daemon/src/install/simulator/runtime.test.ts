import { describe, expect, test as anyTest } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../platform/tempDir.testing.ts";
import { posixTest } from "../../platform/testing.ts";
import { sha256Of } from "../../prediction/managed/download.ts";
import { bunRuntimeSource } from "./runtime.ts";
import { BUN_RUNTIME_BUILDS, BUN_RUNTIME_VERSION, type PinnedBunRuntime } from "./runtimePin.ts";

const test = posixTest("the Simulator never runs on Windows");

const officialBun = process.platform === "darwin" && process.arch === "arm64";

/** A program that is never Bun, as a sealed release Daemon: it prints its usage and exits 2. */
const sealedDaemon = () => {
  const path = join(tempDir("sealed-"), "polaris");
  writeFileSync(path, "#!/bin/sh\necho 'usage: polaris <serve|…>' >&2\nexit 2\n");
  chmodSync(path, 0o755);

  return path;
};

/** A release archive holding `bun` (here a script that hands on to this test's Bun), and its pin. */
const release = async (bun = `#!/bin/sh\nexec '${process.execPath}' "$@"\n`) => {
  const dir = tempDir("bun-release-");
  mkdirSync(join(dir, "bun-test"));
  writeFileSync(join(dir, "bun-test", "bun"), bun);
  const archive = join(dir, "bun-test.zip");
  const packed = Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "bun-test"]);

  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  const bytes = await Bun.file(archive).bytes();

  const pin: PinnedBunRuntime = {
    archive: {
      name: "bun-test.zip",
      url: "https://example.test/bun-test.zip",
      sizeBytes: bytes.length,
      sha256: await sha256Of(archive),
    },
    binary: {
      path: "bun-test/bun",
      sizeBytes: bun.length,
      sha256: await sha256Of(join(dir, "bun-test", "bun")),
    },
  };

  return { pin, bytes };
};

const setup = (pin: PinnedBunRuntime, served: Uint8Array, executable = sealedDaemon()) => {
  const root = join(tempDir("bun-runtime-"), "bun");
  const asked: string[] = [];

  const source = bunRuntimeSource({
    root,
    platform: "test-os",
    executable,
    version: "9.9.9",
    builds: { "test-os": pin },
    fetch: async (url) => {
      asked.push(url);

      return new Response(served);
    },
  });

  return { root, asked, source };
};

const leftIn = (root: string) => {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
};

describe("the Bun that runs the Simulator's tools", () => {
  test("a Daemon that is Bun itself is the runtime, and downloads nothing", async () => {
    const { pin, bytes } = await release();
    const t = setup(pin, bytes, process.execPath);

    const own = { program: process.execPath, env: { BUN_BE_BUN: "1" } };

    expect(await t.source.onDisk()).toEqual(own);
    expect(await t.source.install()).toEqual(own);
    expect(t.asked).toEqual([]);
  });

  test("a sealed Daemon installs the pinned Bun, and scripts run through it", async () => {
    const { pin, bytes } = await release();
    const t = setup(pin, bytes);
    const script = join(tempDir("script-"), "hello.js");
    writeFileSync(script, 'console.log("ran", process.argv[2]);');

    expect(await t.source.onDisk()).toBeNull();
    const runtime = await t.source.install();
    const ran = Bun.spawnSync([runtime.program, script, "here"], { env: { ...runtime.env } });

    expect(runtime.program).toBe(join(t.root, "9.9.9", "bun-test", "bun"));
    expect(ran.stdout.toString()).toBe("ran here\n");
    expect(leftIn(t.root)).toEqual(["9.9.9"]);
    // In place, it is found again without asking the network.
    expect(await t.source.onDisk()).toEqual(runtime);
    expect(await t.source.install()).toEqual(runtime);
    expect(t.asked).toEqual([pin.archive.url]);
  });

  test("an archive that isn't the pinned one is refused, and nothing of it stays", async () => {
    const { pin } = await release();
    const other = await release('#!/bin/sh\necho owned > "$0.ran"\n');

    // The same length, so only the hash tells them apart.
    const t = setup(
      { ...pin, archive: { ...pin.archive, sizeBytes: other.bytes.length } },
      other.bytes
    );

    await Promise.resolve(expect(t.source.install()).rejects.toThrow("published checksum"));
    expect(leftIn(t.root)).toEqual([]);
    expect(await t.source.onDisk()).toBeNull();
  });

  test("a bun inside the archive that isn't the pinned one is refused before it can run", async () => {
    const { pin, bytes } = await release();
    const t = setup({ ...pin, binary: { ...pin.binary, sha256: "0".repeat(64) } }, bytes);

    await Promise.resolve(expect(t.source.install()).rejects.toThrow("pinned size and hash"));
    expect(leftIn(t.root)).toEqual([]);
  });

  test("a sealed Daemon on a platform with no pinned Bun says so", async () => {
    const source = bunRuntimeSource({
      root: tempDir("bun-none-"),
      platform: "linux-x64",
      executable: sealedDaemon(),
    });

    await Promise.resolve(
      expect(source.install()).rejects.toThrow(
        `no Bun ${BUN_RUNTIME_VERSION} to run the Simulator's tools on linux-x64`
      )
    );
  });
});

describe("the pinned Bun", () => {
  test("is the Daemon's own Bun version, so an upgrade re-pins it", () => {
    expect(BUN_RUNTIME_VERSION).toBe(Bun.version);
  });

  const onItsPlatform = officialBun ? anyTest : anyTest.skip;

  onItsPlatform(
    "its darwin-arm64 binary is the one this test runs on [darwin-arm64 only: the one pinned Bun]",
    async () => {
      const pinned = BUN_RUNTIME_BUILDS["darwin-arm64"].binary;

      expect(await sha256Of(process.execPath)).toBe(pinned.sha256);
      expect(Bun.file(process.execPath).size).toBe(pinned.sizeBytes);
    }
  );
});
