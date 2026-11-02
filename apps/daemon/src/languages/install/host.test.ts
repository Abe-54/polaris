import { rejects } from "node:assert/strict";
import { expect, jest } from "bun:test";
import { readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactFixture, hostId, platform } from "./fixture.testing.ts";
import { createHostInstallations, type HostInstallationOptions } from "./host.ts";
import { createInstaller } from "./index.ts";
import { failure, digest } from "./validation.ts";
import { managedLaunchAdapters } from "../availability/launch.ts";
import { createSelectionLedger } from "./selection-ledger.ts";
import { createProjectDiscovery } from "../discovery/index.ts";
import {
  LanguageCheckout,
  WorkspaceId,
  LanguageEffectiveSettings,
  LanguageFormatterSelection,
  LanguageContextIdentity,
  LanguageInstallation,
} from "@polaris/protocol";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const test = posixTest(
  "language storage is checked private by POSIX owner and mode bits; Windows needs ACL checks (ENG-314)"
);

async function hostFixture(overrides: Partial<HostInstallationOptions> = {}) {
  const parent = newTempDir("m31-i1-host-");
  const source = artifactFixture();
  let downloads = 0;
  let probes = 0;
  let releases = 0;
  const registry = createHostInstallations();

  const options: HostInstallationOptions = {
    hostId,
    platform,
    root: join(parent, "private"),
    tools: [source.tool],
    adapters: {
      async *download() {
        downloads++;
        yield source.bytes;
      },
      async decode() {
        return source.payload;
      },
      async approve(exact) {
        return { approved: true, identity: exact.identity };
      },
    },
    async observe() {
      probes++;

      return { connected: true, probes: [] };
    },
    async reserveSelection() {
      return {
        validate: async () => {},
        release: async () => {
          releases++;
        },
      };
    },
    ...overrides,
  };

  return {
    parent,
    source,
    options,
    registry,
    counts: () => ({ downloads, probes, releases }),
    async close() {
      await registry.dispose();
      await removeTempDirSettled(parent);
    },
  };
}

test("immutable Host construction and simultaneous first encounters/manual requests share one job", async () => {
  const f = await hostFixture();

  try {
    const first = f.registry.get(f.options);
    expect(f.registry.get(f.options)).toBe(first);
    const host = await first;
    f.source.tool.version = "mutated";
    expect(host.tool("fake-tool").version).toBe("1.0.0");
    expect(() => f.registry.get({ ...f.options })).toThrow("immutable options");

    const handles = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        host.install("fake-tool", index % 2 ? "install" : "encounter", async () => {})
      )
    );

    expect(new Set(handles.map((handle) => handle.jobId)).size).toBe(1);
    const results = await Promise.all(handles.map((handle) => handle.result));
    expect(new Set(results.map((result) => result.identity)).size).toBe(1);
    expect(f.counts()).toMatchObject({ downloads: 1, releases: 1 });
    expect(f.counts().probes).toBeGreaterThanOrEqual(2);
    expect(host.stats()).toMatchObject({
      jobs: 0,
      waiters: 0,
      observations: 0,
      reservations: 0,
      recovery: [],
    });
    expect((await host.inspect("fake-tool", "feature", false)).preflight).toMatchObject({
      reason: "awaiting-trust",
    });
  } finally {
    await f.close();
  }
});

test("a preflight timeout is typed and retryable, releases demand, and a fresh inspection succeeds", async () => {
  let slow = true;
  const observing = Promise.withResolvers<void>();

  const f = await hostFixture({
    preflightTimeoutMs: 20,
    observe: async (_tool, _phase, _trusted, signal) => {
      if (slow) {
        observing.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      }

      return { connected: true, probes: [] };
    },
  });

  // Fake timers: the deadline passes only when advanced, so a loaded runner can't expire the retry.
  jest.useFakeTimers();

  try {
    const host = await f.registry.get(f.options);
    const timedOut = host.inspect("fake-tool", "install", true);
    await observing.promise;
    jest.advanceTimersByTime(20);
    await rejects(timedOut, { reason: "timeout", retryable: true });
    expect(host.stats()).toMatchObject({ requests: 0 });
    slow = false;
    expect((await host.inspect("fake-tool", "install", true)).preflight._tag).toBe("Eligible");
    expect(host.stats()).toMatchObject({ requests: 0, observations: 0 });
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test("default approval denies without downloading and missing barrier denies before selection", async () => {
  for (const mode of ["approval", "barrier"] as const) {
    const f = await hostFixture();

    try {
      const options = {
        ...f.options,
        ...(mode === "approval"
          ? {
              adapters: {
                download: f.options.adapters.download,
                decode: f.options.adapters.decode,
              },
            }
          : { reserveSelection: undefined }),
      };

      const host = await f.registry.get(options);
      const handle = await host.install("fake-tool", "install", async () => {});
      await rejects(handle.result, {
        reason: mode === "approval" ? "audit-required" : "conflict",
      });
      expect(await host.current("fake-tool")).toBeNull();
      const tree = await readdir(f.options.root, { recursive: true });
      expect(
        tree.filter(
          (path) =>
            path.includes(".stage-") || path.includes(".active-") || path.endsWith("install.lock")
        )
      ).toEqual([]);
      expect(f.counts().downloads).toBe(mode === "approval" ? 0 : 1);
    } finally {
      await f.close();
    }
  }
});

test("live request trust/session revocation blocks selection and releases reservation", async () => {
  const f = await hostFixture();
  let current = true;

  try {
    const host = await f.registry.get({
      ...f.options,
      reserveSelection: async () => {
        current = false;

        return { validate: async () => {}, release: async () => {} };
      },
    });

    const handle = await host.install("fake-tool", "install", async () => {
      if (!current) throw failure("awaiting-trust", "Workspace trust was revoked");
    });

    await rejects(handle.result, { reason: "awaiting-trust" });
    expect(await host.current("fake-tool")).toBeNull();
    expect(host.stats().reservations).toBe(0);
  } finally {
    await f.close();
  }
});

test("cancelled consumer does not cancel its peer or release selection reservation early", async () => {
  const f = await hostFixture();
  let continueSelection = () => {};

  const held = new Promise<void>((resolve) => {
    continueSelection = resolve;
  });

  let reserved = () => {};

  const ready = new Promise<void>((resolve) => {
    reserved = resolve;
  });

  let releases = 0;

  try {
    const host = await f.registry.get({
      ...f.options,
      reserveSelection: async () => ({
        validate: async () => {
          reserved();
          await held;
        },
        release: async () => {
          releases++;
        },
      }),
    });

    const [one, two] = await Promise.all([
      host.install("fake-tool", "install", async () => {}),
      host.install("fake-tool", "encounter", async () => {}),
    ]);

    const rejected = one.result.catch((cause: unknown) => cause);
    await ready;
    one.cancel();
    expect(await rejected).toMatchObject({ reason: "cancelled" });
    expect(releases).toBe(0);
    continueSelection();
    await two.result;
    expect(releases).toBe(1);
    expect(f.counts().downloads).toBe(1);
  } finally {
    continueSelection();
    await f.close();
  }
});

test("observed prerequisite facts remain separate from installation and never infer readiness", async () => {
  const f = await hostFixture();

  const tool = {
    ...f.source.tool,
    requirements: [
      {
        id: "node",
        scope: "server",
        executable: "node",
        version: ">=22.0.0",
        required: true,
        detail: "Node.js 22 or later is required",
      },
    ],
  };

  try {
    const host = await f.registry.get({
      ...f.options,
      tools: [tool],
      observe: async () => ({
        connected: true,
        probes: [{ id: "node", executable: "/fake/node", version: "20.0.0" }],
      }),
    });

    const admission = { cwd: f.parent, requireCurrent: async () => {} };
    const fact = await host.inspect("fake-tool", "install", true, admission);
    expect(fact.prerequisites[0]).toMatchObject({
      outcome: "incompatible",
      effectiveExecutable: "/fake/node",
      detectedVersion: "20.0.0",
    });
    expect(fact.preflight).toMatchObject({ reason: "missing-prerequisite" });
    await rejects(
      host.install("fake-tool", "install", async () => {}, undefined, admission),
      {
        reason: "missing-prerequisite",
      }
    );
    expect(f.counts().downloads).toBe(0);
  } finally {
    await f.close();
  }
});

test("offline failed update preserves old version and explicit rollback selects only a retained identity", async () => {
  const f = await hostFixture();
  const next = artifactFixture("2.0.0");
  let offline = true;

  try {
    const foundation = await createInstaller({
      root: f.options.root,
      hostId,
      platform,
      adapters: f.options.adapters,
    });

    const original = await foundation.install({
      tool: f.source.tool,
      connected: true,
      probes: [],
      intent: "install",
    }).result;

    await foundation.dispose();

    const host = await f.registry.get({
      ...f.options,
      tools: [next.tool],
      adapters: {
        ...f.options.adapters,
        async *download() {
          if (offline) throw failure("install-failed", "Host download is offline", true);
          yield next.bytes;
        },
        decode: async () => next.payload,
      },
    });

    const failed = await host.install("fake-tool", "update", async () => {});
    await rejects(failed.result, {
      reason: "install-failed",
      message: "Host download is offline",
    });
    expect((await host.current("fake-tool"))?.identity).toBe(original.identity);
    const fact = await host.inspect("fake-tool", "feature", true);
    expect(fact.installation).toMatchObject({ retainedVersion: "1.0.0" });
    expect(fact.updateCandidate).toBe("2.0.0");
    offline = false;
    await (
      await host.install("fake-tool", "update", async () => {})
    ).result;
    expect((await host.current("fake-tool"))?.version).toBe("2.0.0");
    await rejects(
      host.rollback("fake-tool", "sha256:" + "f".repeat(64), async () => {}),
      { reason: "not-installed" }
    );
    await (
      await host.rollback("fake-tool", original.identity, async () => {})
    ).result;
    expect((await host.current("fake-tool"))?.identity).toBe(original.identity);
    expect(
      (await readdir(f.options.root, { recursive: true })).filter(
        (path) => path.includes(".stage-") || path.endsWith("install.lock")
      )
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test("approval revoked during the barrier cannot activate and failed lease release prevents readiness", async () => {
  for (const mode of ["revoked", "release-failed"] as const) {
    const f = await hostFixture();
    let approved = true;

    try {
      const host = await f.registry.get({
        ...f.options,
        adapters: {
          ...f.options.adapters,
          approve: async (exact) => ({ approved, identity: exact.identity }),
        },
        reserveSelection: async () => ({
          validate: async () => {
            if (mode === "revoked") approved = false;
          },
          release: async () => {
            if (mode === "release-failed") throw new Error("synthetic lease failure");
          },
        }),
      });

      const handle = await host.install("fake-tool", "install", async () => {});

      if (mode === "revoked") {
        await rejects(handle.result, { reason: "audit-required" });
        expect(await host.current("fake-tool")).toBeNull();
      } else {
        await handle.result;
        expect(host.stats().recovery).toEqual(["fake-tool"]);
        expect(host.stats().cleanupFailures).toHaveLength(1);
        await rejects(host.inspect("fake-tool", "feature", true), {
          reason: "recovery-required",
        });
      }
    } finally {
      await f.close();
    }
  }
});

test("cancellation during reservation acquisition awaits owned release before registry disposal completes", async () => {
  const f = await hostFixture();
  let releaseAcquisition = () => {};

  const gate = new Promise<void>((resolve) => {
    releaseAcquisition = resolve;
  });

  let begun = () => {};

  const ready = new Promise<void>((resolve) => {
    begun = resolve;
  });

  let released = false;

  try {
    const host = await f.registry.get({
      ...f.options,
      reserveSelection: async () => {
        begun();
        await gate;

        return {
          validate: async () => {},
          release: async () => {
            released = true;
          },
        };
      },
    });

    const handle = await host.install("fake-tool", "install", async () => {});
    const cancelled = handle.result.catch((cause: unknown) => cause);
    await ready;
    handle.cancel();
    expect(await cancelled).toMatchObject({ reason: "cancelled" });
    const shutdown = f.registry.dispose();
    expect(released).toBe(false);
    releaseAcquisition();
    await shutdown;
    expect(released).toBe(true);
    expect(host.stats()).toMatchObject({ jobs: 0, selections: 0, reservations: 0 });
  } finally {
    releaseAcquisition();
    await f.close();
  }
});

test("stale installer lock is an explicit recovery fact and never a ready or automatically deleted state", async () => {
  const f = await hostFixture();

  try {
    const host = await f.registry.get(f.options);
    const version = await (await host.install("fake-tool", "install", async () => {})).result;
    const lock = join(f.options.root, digest("fake-tool").slice(7), "install.lock");
    await writeFile(lock, "uncertain previous installer", { mode: 0o600 });
    await rejects(host.inspect("fake-tool", "feature", true), { reason: "recovery-required" });
    await rejects(
      host.install("fake-tool", "update", async () => {}),
      { reason: "recovery-required" }
    );
    expect((await host.current("fake-tool"))?.identity).toBe(version.identity);
    expect(await readFile(lock, "utf8")).toBe("uncertain previous installer");
  } finally {
    await f.close();
  }
});

test("launch resolver requires the selected version's exact approval and a verified provider plan", async () => {
  const f = await hostFixture();
  const next = artifactFixture("2.0.0");
  let approved = true;
  let trusted = true;
  const ledger = createSelectionLedger();

  try {
    const foundation = await createInstaller({
      root: f.options.root,
      hostId,
      platform,
      adapters: f.options.adapters,
    });

    await foundation.install({
      tool: f.source.tool,
      probes: [],
      connected: true,
      intent: "install",
    }).result;
    await foundation.dispose();

    const host = await f.registry.get({
      ...f.options,
      tools: [next.tool],
      reserveSelection: (exact, signal) => ledger.reserveSelection(exact.tool.id, signal),
      adapters: {
        ...f.options.adapters,
        approve: async (exact) => ({
          approved: approved && exact.tool.version === "1.0.0",
          identity: exact.identity,
        }),
      },
    });

    const path = join(f.parent, "file.fake");
    await writeFile(path, "synthetic");

    const checkout = LanguageCheckout.cases.Workspace.make({
      workspaceId: WorkspaceId.make("fake-workspace"),
      path: f.parent,
    });

    const discovery = createProjectDiscovery({
      registry: async () => ({ checkout, workspacePath: f.parent }),
    });

    const facts = await discovery.discover({
      checkout,
      path,
      providerId: "fake",
      settings: LanguageEffectiveSettings.make({
        settings: {},
        revision: 0,
        formatOnSave: true,
        formatter: LanguageFormatterSelection.cases.None.make({}),
        providers: ["fake"],
        origins: {},
      }),
    });

    const base = {
      host,
      ledger,
      toolId: () => "fake-tool",
      requireCurrent: () => async () => {
        if (!trusted) throw failure("awaiting-trust", "Workspace trust was revoked");
      },
    };

    const request = {
      facts,
      signal: new AbortController().signal,
      isCurrent: () => true,
      context: LanguageContextIdentity.make({
        hostId,
        clientId: "fake-client",
        contextId: "fake-context",
        checkout,
        projectRoot: facts.projectRoot,
        providerId: "fake",
        configurationFingerprint: facts.configurationFingerprint,
        generation: 1,
      }),
    };

    const missing = managedLaunchAdapters(base);
    const omittedPlanLease = await missing.reserveLaunch(request);
    await rejects(missing.resolveLaunch(facts, omittedPlanLease, request), {
      reason: "audit-required",
    });
    await omittedPlanLease.release();

    const resolver = managedLaunchAdapters({
      ...base,
      plan: async (_facts, installed) => {
        const entry = join(installed.directory, "bin/tool");

        return {
          identity: installed.identity,
          entry,
          launch: { executable: entry, args: [], cwd: facts.projectRoot, environment: {} },
        };
      },
    });

    const lease = await resolver.reserveLaunch(request);
    const launch = await resolver.resolveLaunch(facts, lease, request);
    expect(launch.executable).toBe(join((await host.current("fake-tool"))!.directory, "bin/tool"));
    expect((await host.inspect("fake-tool", "feature", true)).updateCandidate).toBe("2.0.0");
    await rejects(ledger.reserveSelection("fake-tool", request.signal), { reason: "conflict" });
    approved = false;
    await rejects(resolver.resolveLaunch(facts, lease, request), { reason: "audit-required" });
    approved = true;
    trusted = false;
    await rejects(resolver.resolveLaunch(facts, lease, request), { reason: "awaiting-trust" });
    await lease.release();
    await rejects(resolver.resolveLaunch(facts, lease, request), { reason: "conflict" });
    ledger.dispose();
  } finally {
    await f.close();
  }
});

test("managed discovery defers absent private Node while preserving approval and installed facts", async () => {
  const f = await hostFixture();

  const tool = {
    ...f.source.tool,
    requirements: [
      {
        id: "node",
        scope: "server",
        executable: "node",
        version: ">=24.18.0",
        required: true,
        detail: "Private Polaris Node",
      },
    ],
  };

  try {
    let approved = true;

    const host = await f.registry.get({
      ...f.options,
      tools: [tool],
      adapters: {
        ...f.options.adapters,
        approve: async (exact) => ({ approved, identity: exact.identity }),
      },
    });

    const admission = { cwd: f.parent, requireCurrent: async () => {} };
    const ordinary = await host.inspect("fake-tool", "install", true, admission);

    expect(ordinary.preflight).toMatchObject({ reason: "missing-prerequisite" });

    const pending = await host.inspect("fake-tool", "install", true, admission, undefined, {
      deferManagedNode: true,
    });

    expect(pending.preflight).toMatchObject({ artifactId: "fake" });
    expect(pending.prerequisites[0]?.outcome).toBe("missing");
    expect(pending.installation).toEqual(LanguageInstallation.cases.NotInstalled.make({}));
    expect(await host.current("fake-tool")).toBeNull();
    expect(f.counts().downloads).toBe(0);
    approved = false;

    const denied = await host.inspect("fake-tool", "install", true, admission, undefined, {
      deferManagedNode: true,
    });

    expect(denied.preflight).toMatchObject({ reason: "audit-required" });
    expect(f.counts().downloads).toBe(0);
  } finally {
    await f.close();
  }
});

test("pinned inspection preserves Trust and refuses a retained descriptor from another pin", async () => {
  const f = await hostFixture();
  const next = createHostInstallations();

  try {
    const host = await f.registry.get(f.options);
    await (
      await host.install("fake-tool", "install", async () => {})
    ).result;

    const untrusted = await host.inspect("fake-tool", "feature", false, undefined, undefined, {
      pinned: true,
    });

    expect(untrusted.preflight).toMatchObject({ reason: "awaiting-trust" });
    await f.registry.dispose();

    const updated = await next.get({ ...f.options, tools: [artifactFixture("2.0.0").tool] });
    const retained = await updated.inspect("fake-tool", "feature", true);

    expect(retained.installation).toMatchObject({ version: "1.0.0" });
    expect(retained.updateCandidate).toBe("2.0.0");
    expect(retained.preflight).toMatchObject({ artifactId: "fake" });
    await rejects(
      updated.inspect("fake-tool", "feature", true, undefined, undefined, { pinned: true }),
      { reason: "conflict" }
    );
  } finally {
    await next.dispose();
    await f.close();
  }
});
