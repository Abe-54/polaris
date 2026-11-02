import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { writeFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { artifactFixture } from "./fixture.testing.ts";
import { createDemandObservations } from "./observations.ts";
import { runtimeObservationAdapter } from "../availability/observations.ts";
import { failure } from "./validation.ts";
import { Effect, Schema } from "effect";
import { LanguageTool } from "@polaris/protocol";
import { createHostInstallations } from "./host.ts";
import { hostId, platform } from "./fixture.testing.ts";
import { HostLanguageInstallation } from "../availability/service.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const privateStorage = posixTest(
  "language storage is checked private by POSIX owner and mode bits; Windows needs ACL checks (ENG-314)"
);

const requirement = {
  id: "fake",
  executable: "fake",
  scope: "server",
  version: ">=1.0.0",
  required: true,
  detail: "Synthetic prerequisite",
} as const;

const tool = Schema.decodeUnknownSync(LanguageTool)({
  ...artifactFixture().tool,
  requirements: [requirement],
});

const output = { exitCode: 0, stdout: "synthetic-v1", stderr: "" };

function latch() {
  let resolve = () => {};

  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });

  return { promise, resolve };
}

async function fixture() {
  const root = newTempDir("m31-i1-observe-");
  const executable = join(root, "fake");
  await writeFile(executable, "synthetic bytes; never executed");
  await chmod(executable, 0o700);

  return { root, executable, close: () => removeTempDirSettled(root) };
}

test("retry cancellation during prior observation cleanup preserves consumer accounting", async () => {
  const entered = latch();
  const finish = latch();
  const lifetime = new AbortController();
  let runs = 0;

  const jobs = createDemandObservations({
    lifetime: lifetime.signal,
    observe: async () => {
      if (++runs === 1) {
        entered.resolve();
        await finish.promise;
      }

      return { connected: true, probes: [] };
    },
  });

  const selected = { ...tool, requirements: [] };
  const first = new AbortController();
  const initial = jobs.observe(selected, "install", true, first.signal);

  await entered.promise;
  first.abort();
  await rejects(initial, { reason: "cancelled" });

  const retry = new AbortController();
  const retrying = jobs.observe(selected, "install", true, retry.signal);

  await new Promise((resolve) => setTimeout(resolve, 0));
  retry.abort();
  await rejects(retrying, { reason: "cancelled" });
  finish.resolve();
  expect(await jobs.observe(selected, "install", true, lifetime.signal)).toEqual({
    connected: true,
    probes: [],
  });
  expect(runs).toBe(2);
  expect(jobs.stats()).toEqual({ observations: 0, inspections: 0 });
  lifetime.abort();
  await jobs.dispose();
});

test("guarded observations refuse boolean-only authority and retain requirement-free no-exec observations", async () => {
  let runs = 0;

  const adapter = runtimeObservationAdapter({
    configured: {},
    searchPath: [],
    versions: {},
    connected: () => true,
    run: async () => {
      runs++;

      return output;
    },
  });

  const lifetime = new AbortController();
  const jobs = createDemandObservations({ lifetime: lifetime.signal, observe: adapter.observe });

  try {
    await rejects(jobs.observe(tool, "feature", true, lifetime.signal), { reason: "not-ready" });
    expect(
      await jobs.observe({ ...tool, requirements: [] }, "feature", true, lifetime.signal)
    ).toEqual({ connected: true, probes: [] });
    expect(runs).toBe(0);
  } finally {
    lifetime.abort();
    await jobs.dispose();
    await adapter.dispose();
  }
});

test("authority revoked while locating a prerequisite prevents the version command", async () => {
  const f = await fixture();
  let checks = 0;
  let runs = 0;

  const adapter = runtimeObservationAdapter({
    configured: { fake: f.executable },
    searchPath: [],
    versions: { fake: { argv: [], parse: () => "1.0.0" } },
    connected: () => true,
    run: async () => {
      runs++;

      return output;
    },
  });

  try {
    await rejects(
      adapter.observe(tool, "feature", true, new AbortController().signal, {
        cwd: f.root,
        requireCurrent: async () => {
          if (++checks === 3) throw failure("stale-generation", "Captured principal replaced");
        },
      }),
      { reason: "stale-generation" }
    );
    expect(checks).toBe(3);
    expect(runs).toBe(0);
  } finally {
    await adapter.dispose();
    await f.close();
  }
});

test("one captured admission deduplicates observations with independent cancellation", async () => {
  const f = await fixture();
  const started = latch();
  const finish = latch();
  const lifetime = new AbortController();
  let runs = 0;
  let runnerSignal: AbortSignal | undefined;

  const adapter = runtimeObservationAdapter({
    configured: { fake: f.executable },
    searchPath: [],
    versions: { fake: { argv: ["--version"], parse: () => "1.0.0" } },
    connected: () => true,
    run: async (_command, signal) => {
      runs++;
      runnerSignal = signal;
      started.resolve();
      await finish.promise;

      return output;
    },
  });

  const jobs = createDemandObservations({ lifetime: lifetime.signal, observe: adapter.observe });
  const admission = { cwd: f.root, requireCurrent: async () => {} };
  const first = new AbortController();

  const a = jobs
    .observe(tool, "feature", true, first.signal, admission)
    .catch((cause: unknown) => cause);

  const b = jobs.observe(tool, "feature", true, lifetime.signal, admission);

  try {
    await started.promise;
    first.abort();
    expect(await a).toMatchObject({ reason: "cancelled" });
    expect(runnerSignal?.aborted).toBe(false);
    finish.resolve();
    expect((await b).probes).toEqual([{ id: "fake", executable: f.executable, version: "1.0.0" }]);
    expect(runs).toBe(1);
  } finally {
    finish.resolve();
    lifetime.abort();
    await jobs.dispose();
    await adapter.dispose();
    await f.close();
  }
});

test("captured nested checkout admissions do not share probes and guards revoke facts after waits", async () => {
  const f = await fixture();
  const started = latch();
  const finish = latch();
  const lifetime = new AbortController();
  await mkdir(join(f.root, "nested"));
  const cwds: string[] = [];
  let current = true;

  const guard = async () => {
    if (!current) throw failure("awaiting-trust", "Synthetic trust revoked");
  };

  const adapter = runtimeObservationAdapter({
    configured: { fake: f.executable },
    searchPath: [],
    versions: { fake: { argv: [], parse: () => "1.0.0" } },
    connected: () => true,
    run: async (command) => {
      cwds.push(command.cwd);

      if (cwds.length === 2) started.resolve();
      await finish.promise;

      return output;
    },
  });

  const jobs = createDemandObservations({ lifetime: lifetime.signal, observe: adapter.observe });

  const a = jobs.observe(tool, "feature", true, lifetime.signal, {
    cwd: f.root,
    requireCurrent: guard,
  });

  const b = jobs.observe(tool, "feature", true, lifetime.signal, {
    cwd: join(f.root, "nested"),
    requireCurrent: guard,
  });

  const checked = Promise.all([
    rejects(a, { reason: "awaiting-trust" }),
    rejects(b, { reason: "awaiting-trust" }),
  ]);

  try {
    await started.promise;
    current = false;
    finish.resolve();
    await checked;
    expect(cwds.sort()).toEqual([f.root, join(f.root, "nested")].sort());
  } finally {
    finish.resolve();
    lifetime.abort();
    await jobs.dispose();
    await adapter.dispose();
    await f.close();
  }
});

test("last cancellation aborts the probe but observation disposal retains underlying cleanup", async () => {
  const f = await fixture();
  const started = latch();
  const cleanup = latch();
  const lifetime = new AbortController();
  const cancel = new AbortController();
  let runnerSignal: AbortSignal | undefined;

  const adapter = runtimeObservationAdapter({
    configured: { fake: f.executable },
    searchPath: [],
    versions: { fake: { argv: [], parse: () => "1.0.0" } },
    connected: () => true,
    run: async (_command, signal) => {
      runnerSignal = signal;
      started.resolve();
      await cleanup.promise;

      return output;
    },
  });

  const jobs = createDemandObservations({ lifetime: lifetime.signal, observe: adapter.observe });

  const result = jobs
    .observe(tool, "feature", true, cancel.signal, { cwd: f.root, requireCurrent: async () => {} })
    .catch((cause: unknown) => cause);

  try {
    await started.promise;
    cancel.abort();
    expect(await result).toMatchObject({ reason: "cancelled" });
    expect(runnerSignal?.aborted).toBe(true);
    let disposed = false;

    const disposal = jobs.dispose().then(() => {
      disposed = true;
    });

    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(jobs.stats().observations).toBe(1);
    cleanup.resolve();
    await disposal;
    expect(disposed).toBe(true);
  } finally {
    cleanup.resolve();
    lifetime.abort();
    await jobs.dispose();
    await adapter.dispose();
    await f.close();
  }
});

privateStorage(
  "Effect inspection forwards captured admission and interruption to the owned Host observation",
  async () => {
    const f = await fixture();
    const registry = createHostInstallations();
    const started = latch();
    const cleanup = latch();
    let observationSignal: AbortSignal | undefined;
    let observationCwd: string | undefined;

    const host = await registry.get({
      root: join(f.root, "private"),
      hostId,
      platform,
      tools: [tool],
      adapters: { download: async function* () {}, decode: async () => artifactFixture().payload },
      observe: async (_tool, _phase, _trusted, signal, admission) => {
        observationSignal = signal;
        observationCwd = admission?.cwd;
        started.resolve();
        await cleanup.promise;

        return { connected: true, probes: [] };
      },
    });

    const cancel = new AbortController();
    const admission = { cwd: f.root, requireCurrent: async () => {} };

    const result = Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HostLanguageInstallation;

        return yield* service.inspect(tool.id, "feature", true, admission);
      }).pipe(Effect.provide(HostLanguageInstallation.layer(host))),
      { signal: cancel.signal }
    ).catch((cause: unknown) => cause);

    try {
      await started.promise;
      cancel.abort();
      await result;
      expect(observationSignal?.aborted).toBe(true);
      expect(observationCwd).toBe(f.root);
      let disposed = false;

      const disposal = registry.dispose().then(() => {
        disposed = true;
      });

      await Promise.resolve();
      expect(disposed).toBe(false);
      cleanup.resolve();
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      cleanup.resolve();
      await registry.dispose();
      await f.close();
    }
  }
);
