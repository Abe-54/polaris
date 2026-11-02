import { test, expect } from "bun:test";
import { rejects } from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeProbeAdapter } from "./probes.ts";
import { runHostVersion } from "./version-process.ts";
import { failure } from "../install/validation.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const posixTools = posixTest(
  "the synthetic probe is a POSIX sh child in its own process group (ENG-296)"
);

const requirement = {
  id: "fake",
  executable: "fake",
  scope: "server",
  version: ">=1.0.0",
  required: true,
  detail: "Synthetic runtime required",
} as const;

test("runtime probes preserve existing path/version facts, refuse untrusted execution and recheck live trust", async () => {
  let runs = 0;
  let trusted = true;

  const probe = runtimeProbeAdapter({
    configured: { fake: process.execPath },
    searchPath: [],
    cwd: tmpdir(),
    versions: {
      fake: {
        argv: ["--version"],
        parse: (value) => (value.stdout === "synthetic-v1" ? "1.0.0" : null),
      },
    },
    requireCurrent: async () => {
      if (!trusted) throw failure("awaiting-trust", "Workspace trust was revoked");
    },
    run: async () => {
      runs++;

      return { exitCode: 0, stdout: "synthetic-v1", stderr: "" };
    },
  });

  expect(await probe([requirement], false, new AbortController().signal)).toEqual([
    { id: "fake", executable: null, version: null },
  ]);
  expect(runs).toBe(0);
  expect(await probe([requirement], true, new AbortController().signal)).toEqual([
    { id: "fake", executable: await realpath(process.execPath), version: "1.0.0" },
  ]);
  expect(runs).toBe(1);
  trusted = false;
  await rejects(probe([requirement], true, new AbortController().signal), {
    reason: "awaiting-trust",
  });
  expect(runs).toBe(1);
});

test("unknown version output and missing configured executable remain distinct", async () => {
  const base = {
    configured: { fake: process.execPath },
    searchPath: [],
    cwd: tmpdir(),
    requireCurrent: async () => {},
    versions: { fake: { argv: ["--version"], parse: () => null } },
    run: async () => ({ exitCode: 0, stdout: "unrecognized", stderr: "" }),
  };

  const unknown = await runtimeProbeAdapter(base)(
    [requirement],
    true,
    new AbortController().signal
  );

  expect(unknown[0]).toEqual({
    id: "fake",
    executable: await realpath(process.execPath),
    version: null,
  });

  const missing = await runtimeProbeAdapter({
    ...base,
    configured: { fake: "/nonexistent-m31-i1-runtime" },
  })([requirement], true, new AbortController().signal);

  expect(missing[0]).toEqual({ id: "fake", executable: null, version: null });
});

posixTools(
  "Host version runner bounds synthetic child output and cleans its POSIX process group",
  async () => {
    const root = newTempDir("m31-i1-probe-");

    try {
      const script = join(root, "synthetic.ts");
      await writeFile(script, 'process.stdout.write("synthetic-v1");');
      expect(
        await runHostVersion(
          { executable: process.execPath, argv: [script], cwd: root },
          new AbortController().signal
        )
      ).toEqual({ exitCode: 0, stdout: "synthetic-v1", stderr: "" });
      await writeFile(script, 'process.stdout.write("x".repeat(8192));');
      await rejects(
        runHostVersion(
          { executable: process.execPath, argv: [script], cwd: root },
          new AbortController().signal
        ),
        { reason: "too-large" }
      );
      const abort = new AbortController();
      abort.abort();
      await rejects(
        runHostVersion({ executable: process.execPath, argv: [script], cwd: root }, abort.signal),
        { reason: "cancelled" }
      );
    } finally {
      await removeTempDirSettled(root);
    }
  }
);

test("probe disposal awaits the resource-bearing runner instead of abandoning cancelled cleanup", async () => {
  let finish = () => {};

  let started = () => {};

  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });

  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const probe = runtimeProbeAdapter({
    configured: { fake: process.execPath },
    searchPath: [],
    cwd: tmpdir(),
    versions: { fake: { argv: ["--version"], parse: () => "1.0.0" } },
    requireCurrent: async () => {},
    run: async () => {
      started();
      await held;

      return { exitCode: 0, stdout: "synthetic", stderr: "" };
    },
  });

  const result = probe([requirement], true, new AbortController().signal).catch(
    (cause: unknown) => cause
  );

  await ready;
  let disposed = false;

  const disposal = probe.dispose().then(() => {
    disposed = true;
  });

  await Promise.resolve();
  expect(disposed).toBe(false);
  finish();
  await disposal;
  expect(await result).toMatchObject({ reason: "cancelled" });
  expect(disposed).toBe(true);
});
