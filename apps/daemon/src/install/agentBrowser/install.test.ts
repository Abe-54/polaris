import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PinnedFile } from "../../prediction/managed/catalog.ts";
import { installAgentBrowser, installedOnDisk, NoAgentBrowserBuild } from "./install.ts";

const SCRIPT = new TextEncoder().encode("#!/bin/sh\necho agent-browser 9.9.9\n");

const pin = (bytes: Uint8Array): PinnedFile => ({
  name: "agent-browser-test",
  url: "https://example.invalid/agent-browser-test",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = (served: Uint8Array, pinned: Uint8Array = served) => {
  const root = mkdtempSync(join(tmpdir(), "ab-install-"));
  roots.push(root);
  let fetched = 0;

  return {
    root,
    fetched: () => fetched,
    options: {
      root,
      platform: "test-arch",
      version: "9.9.9",
      assets: { "test-arch": pin(pinned) },
      fetch: async () => {
        fetched += 1;

        return new Response(served);
      },
    },
  };
};

describe("installAgentBrowser", () => {
  test("installs a runnable binary once, and an upgrade removes the old version", async () => {
    const t = setup(SCRIPT);
    mkdirSync(join(t.root, "0.1.0"));

    const { binary } = await installAgentBrowser(t.options);
    const run = Bun.spawnSync([binary]);
    expect(run.stdout.toString()).toBe("agent-browser 9.9.9\n");
    expect(readdirSync(t.root)).toEqual(["9.9.9"]);

    await installAgentBrowser(t.options);
    expect(t.fetched()).toBe(1);
  });

  test("a download that doesn't match the pinned hash is never installed", async () => {
    const tampered = new TextEncoder().encode("#!/bin/sh\necho owned!!!!!!!!!!!!!!!!!!\n");
    const t = setup(tampered.slice(0, SCRIPT.length), SCRIPT);

    await Promise.resolve(
      expect(installAgentBrowser(t.options)).rejects.toThrow("didn't match its published checksum")
    );
    expect(existsSync(join(t.root, "9.9.9", "agent-browser-test"))).toBe(false);
  });

  test("a platform without a build is refused before any download", async () => {
    const t = setup(SCRIPT);

    await Promise.resolve(
      expect(installAgentBrowser({ ...t.options, platform: "plan9-mips" })).rejects.toBeInstanceOf(
        NoAgentBrowserBuild
      )
    );
    expect(t.fetched()).toBe(0);
  });

  test("an installed binary is found on disk without a download; a partial one is not", async () => {
    const t = setup(SCRIPT);

    expect(await installedOnDisk(t.options)).toBeNull();
    const { binary } = await installAgentBrowser(t.options);
    expect(await installedOnDisk(t.options)).toEqual({ binary });
    await Bun.write(binary, SCRIPT.slice(1));
    expect(await installedOnDisk(t.options)).toBeNull();
  });
});
