import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { system32 } from "../../platform/processes.ts";
import { extractBuild } from "../../prediction/managed/process.ts";
import { tempDir } from "../../platform/tempDir.testing.ts";
import { installAgentDesktop, installedOnDisk, NoAgentDesktopBuild } from "./install.ts";
import type { PinnedBuild } from "./pin.ts";

const windows = process.platform === "win32";

const BINARY = windows ? "agent-desktop-test.cmd" : "agent-desktop-test";

const SCRIPT = windows
  ? "@echo agent-desktop 9.9.9\r\n"
  : '#!/bin/sh\necho agent-desktop 9.9.9 "$(cat "$(dirname "$0")/helper")"\n';

/** A release archive like upstream's: the binary and a helper beside it, packed by `tar`. */
const archiveOf = (files: Readonly<Record<string, string>>) => {
  const src = tempDir("ad-src-");
  const out = join(tempDir("ad-out-"), "build.tar.gz");

  for (const [name, text] of Object.entries(files)) writeFileSync(join(src, name), text);

  const tar = Bun.spawnSync([
    windows ? system32("tar.exe") : "tar",
    "-czf",
    out,
    "-C",
    src,
    ...Object.keys(files),
  ]);

  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());

  return new Uint8Array(readFileSync(out));
};

const GOOD = archiveOf({ [BINARY]: SCRIPT, helper: "helper-ok" });

const pin = (archive: Uint8Array, binarySize = SCRIPT.length): PinnedBuild => ({
  archive: {
    name: "agent-desktop-test.tar.gz",
    url: "https://example.invalid/agent-desktop-test.tar.gz",
    sizeBytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  },
  binary: { name: BINARY, sizeBytes: binarySize },
});

const setup = (served: Uint8Array, pinned: PinnedBuild = pin(served)) => {
  const root = tempDir("ad-install-");
  let fetched = 0;
  let extracted = 0;

  return {
    root,
    fetched: () => fetched,
    extracted: () => extracted,
    options: {
      root,
      platform: "test-arch",
      version: "9.9.9",
      builds: { "test-arch": pinned },
      fetch: async () => {
        fetched += 1;

        return new Response(served);
      },
      extract: async (archive: string, dir: string) => {
        extracted += 1;
        await extractBuild(archive, dir);
      },
    },
  };
};

describe("installAgentDesktop", () => {
  test("installs a runnable binary beside its helper once, and an upgrade removes the old version", async () => {
    const t = setup(GOOD);
    mkdirSync(join(t.root, "1.0.0"));

    const { binary } = await installAgentDesktop(t.options);

    const run = Bun.spawnSync(windows ? [system32("cmd.exe"), "/d", "/c", binary] : [binary]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe(
      windows ? "agent-desktop 9.9.9" : "agent-desktop 9.9.9 helper-ok"
    );
    expect(readdirSync(t.root)).toEqual(["9.9.9"]);

    await installAgentDesktop(t.options);
    expect(await installedOnDisk(t.options)).toEqual({ binary });
    expect(t.fetched()).toBe(1);
  });

  test("an archive that doesn't match the pinned hash is never unpacked or installed", async () => {
    const tampered = archiveOf({ [BINARY]: SCRIPT.replace("9.9.9", "6.6.6"), helper: "owned" });

    const t = setup(tampered, {
      ...pin(GOOD),
      archive: { ...pin(GOOD).archive, sizeBytes: tampered.length },
    });

    await Promise.resolve(
      expect(installAgentDesktop(t.options)).rejects.toThrow("didn't match its published checksum")
    );
    expect(t.extracted()).toBe(0);
    expect(existsSync(join(t.root, "9.9.9"))).toBe(false);
  });

  test("an archive without the pinned binary leaves no version folder", async () => {
    const t = setup(GOOD, pin(GOOD, SCRIPT.length + 1));

    await Promise.resolve(
      expect(installAgentDesktop(t.options)).rejects.toThrow("has no agent-desktop-test")
    );
    expect(existsSync(join(t.root, "9.9.9"))).toBe(false);
    expect(await installedOnDisk(t.options)).toBeNull();
  });

  test.each(["plan9-mips", "linux-x64-musl"])(
    "%s has no build and is refused before any download",
    async (platform) => {
      const t = setup(GOOD);
      const { builds: _, ...pinned } = t.options;

      await Promise.resolve(
        expect(installAgentDesktop({ ...pinned, platform })).rejects.toBeInstanceOf(
          NoAgentDesktopBuild
        )
      );
      expect(t.fetched()).toBe(0);
    }
  );

  test("an installed binary is found on disk without a download; a damaged one is not", async () => {
    const t = setup(GOOD);

    expect(await installedOnDisk(t.options)).toBeNull();
    const { binary } = await installAgentDesktop(t.options);
    expect(await installedOnDisk(t.options)).toEqual({ binary });
    await Bun.write(binary, SCRIPT.slice(1));
    expect(await installedOnDisk(t.options)).toBeNull();
  });
});
