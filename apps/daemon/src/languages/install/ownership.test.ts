import { expect } from "bun:test";
import { rejects, throws } from "node:assert/strict";
import { join } from "node:path";
import { createHostInstallations } from "./host.ts";
import { createInstallOwnership, type InstallOwnerAuthority } from "./ownership.ts";
import { artifactFixture, hostId, platform } from "./fixture.testing.ts";
import { failure } from "./validation.ts";
import { LanguageError } from "@polaris/protocol";
import { Schema } from "effect";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const test = posixTest(
  "language storage is checked private by POSIX owner and mode bits; Windows needs ACL checks (ENG-314)"
);

function latch() {
  let resolve = () => {};

  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });

  return { resolve, promise };
}

function authority(clientId = "synthetic-client") {
  const lifetime = new AbortController();

  const value: InstallOwnerAuthority = {
    principal: { clientId },
    lifetime: lifetime.signal,
    requireCurrent: async () => {},
    authorize: async () => {},
  };

  return { lifetime, value };
}

async function fixture() {
  const root = newTempDir("m31-i1-ownership-");
  const source = artifactFixture();
  const started = latch();
  const finish = latch();
  const registry = createHostInstallations();
  let downloads = 0;
  let downloadSignal: AbortSignal | undefined;

  const host = await registry.get({
    root: join(root, "private"),
    hostId,
    platform,
    tools: [source.tool],
    adapters: {
      async *download(_exact, signal) {
        downloads++;
        downloadSignal = signal;
        started.resolve();
        await finish.promise;
        yield source.bytes;
      },
      decode: async () => source.payload,
      approve: async (exact) => ({ approved: true, identity: exact.identity }),
    },
    observe: async () => ({ connected: true, probes: [] }),
    reserveSelection: async () => ({ validate: async () => {}, release: async () => {} }),
  });

  const request = {
    toolId: source.tool.id,
    version: source.tool.version,
    intent: "install",
  } as const;

  return {
    host,
    request,
    started,
    finish,
    stats: () => ({ downloads, downloadSignal }),
    async close() {
      finish.resolve();
      await registry.dispose();
      await removeTempDirSettled(root);
    },
  };
}

async function terminal(
  updates: AsyncIterableIterator<import("./types.ts").Progress, undefined, unknown>
) {
  for await (const progress of updates) {
    if (progress.phase === "completed") return progress;
  }

  throw new Error("Synthetic install did not complete");
}

test("exact owners share one job but cancel only their own consumers; foreign and reconnect access is denied", async () => {
  const f = await fixture();
  const ownership = createInstallOwnership(f.host);
  const a = ownership.bind(authority().value);
  const b = ownership.bind(authority("other-client").value);
  const reconnect = ownership.bind(authority().value);

  try {
    const one = await a.start(f.request);
    const two = await b.start({ ...f.request, intent: "encounter" });
    await f.started.promise;
    expect(one.jobId).toBe(two.jobId);
    expect(f.stats().downloads).toBe(1);
    await rejects(reconnect.cancel(one.jobId), { reason: "not-owner" });
    await rejects(reconnect.watch(one.jobId), { reason: "not-owner" });
    const watched = await a.watch(one.jobId);
    const first = await watched.updates.next();
    expect(first.done).toBe(false);

    if (first.done) throw new Error("Expected retained progress");
    expect(first.value.phase).toBe("downloading");
    await a.cancel(one.jobId);
    expect(f.stats().downloadSignal?.aborted).toBe(false);
    await rejects(watched.updates.next(), { reason: "cancelled" });
    const survivor = await b.watch(two.jobId);
    f.finish.resolve();
    expect((await terminal(survivor.updates)).phase).toBe("completed");
    await survivor.dispose();
    const replay = await b.watch(two.jobId);
    await b.cancel(two.jobId);
    const replayed = await replay.updates.next();

    if (replayed.done) throw new Error("Expected completed progress replay");
    expect(replayed.value.phase).toBe("completed");
    expect((await replay.updates.next()).done).toBe(true);
    expect(ownership.stats().streams).toBe(0);
  } finally {
    await ownership.dispose();
    await f.close();
  }
});

test("missing explicit grants and mismatched pinned versions cannot start installation", async () => {
  const f = await fixture();
  const ownership = createInstallOwnership(f.host);

  const denied = ownership.bind({
    ...authority().value,
    authorize: async () => {
      throw failure("not-owner", "Explicit install grant absent");
    },
  });

  const allowed = ownership.bind(authority("allowed").value);

  try {
    await rejects(denied.start(f.request), { reason: "not-owner" });
    await rejects(allowed.start({ ...f.request, version: "invented-version" }), {
      reason: "conflict",
    });
    await rejects(
      allowed.start({
        ...f.request,
        intent: "rollback",
        retainedIdentity: `sha256:${"0".repeat(64)}`,
      }),
      { reason: "not-installed" }
    );
    expect(f.stats().downloads).toBe(0);
    expect(ownership.stats().consumers).toBe(0);
  } finally {
    await ownership.dispose();
    await f.close();
  }
});

test("current authority is rechecked after a grant await even when the lifetime has not sealed", async () => {
  const f = await fixture();
  const ownership = createInstallOwnership(f.host);
  let current = true;

  const owner = ownership.bind({
    ...authority().value,
    requireCurrent: async () => {
      if (!current) throw failure("not-owner", "Actual principal generation replaced");
    },
    authorize: async () => {
      current = false;
    },
  });

  try {
    await rejects(owner.start(f.request), { reason: "not-owner" });
    expect(f.stats().downloads).toBe(0);
    expect(ownership.stats().consumers).toBe(0);
  } finally {
    await ownership.dispose();
    await f.close();
  }
});

test("grant revocation denies later progress and mandatory cleanup never asks for a new grant", async () => {
  const f = await fixture();
  const ownership = createInstallOwnership(f.host);
  let granted = true;
  let authorizations = 0;

  const owner = ownership.bind({
    ...authority().value,
    authorize: async () => {
      authorizations++;

      if (!granted) throw failure("not-owner", "Install grant revoked");
    },
  });

  try {
    const job = await owner.start(f.request);
    await f.started.promise;
    const stream = await owner.watch(job.jobId);
    await stream.updates.next();
    const pending = stream.updates.next();
    granted = false;
    f.finish.resolve();
    await rejects(pending, { reason: "not-owner" });
    const before = authorizations;
    await owner.dispose();
    expect(authorizations).toBe(before);
    expect(ownership.stats().streams).toBe(0);
    expect(ownership.stats().consumers).toBe(0);
  } finally {
    await ownership.dispose();
    await f.close();
  }
});

test("lifetime replacement seals pending progress synchronously and forbids authority rebinding", async () => {
  const f = await fixture();
  const ownership = createInstallOwnership(f.host);
  const captured = authority();
  const owner = ownership.bind(captured.value);

  try {
    expect(ownership.bind(captured.value)).toBe(owner);
    throws(() => ownership.bind({ ...captured.value }), { reason: "not-owner" });
    const job = await owner.start(f.request);
    await f.started.promise;
    const stream = await owner.watch(job.jobId);
    await stream.updates.next();
    const pending = stream.updates.next();
    captured.lifetime.abort();
    await rejects(pending, { reason: "cancelled" });
    await owner.dispose();
    expect(owner.stats().sealed).toBe(true);
    throws(() => ownership.bind(captured.value), { reason: "not-owner" });
    expect(ownership.stats().consumers).toBe(0);
    expect(ownership.stats().streams).toBe(0);
  } finally {
    await ownership.dispose();
    await f.close();
  }
});

test("disposal retains delayed handle acquisition until the actual consumer is bound and detached", async () => {
  const f = await fixture();
  const acquired = latch();
  const deliver = latch();

  const host = {
    ...f.host,
    async install(...args: Parameters<typeof f.host.install>) {
      const handle = await f.host.install(...args);
      acquired.resolve();
      await deliver.promise;

      return handle;
    },
  };

  const ownership = createInstallOwnership(host);
  const owner = ownership.bind(authority().value);
  const starting = owner.start(f.request).catch((cause: unknown) => cause);

  try {
    await acquired.promise;
    await f.started.promise;
    let disposed = false;

    const disposal = owner.dispose().then(() => {
      disposed = true;
    });

    await Promise.resolve();
    expect(disposed).toBe(false);
    deliver.resolve();
    await disposal;
    expect(disposed).toBe(true);
    expect(await starting).toMatchObject({ reason: "cancelled" });
    expect(ownership.stats().consumers).toBe(0);
    expect(owner.stats().pending).toBe(0);
    expect(f.stats().downloadSignal?.aborted).toBe(true);
  } finally {
    deliver.resolve();
    await ownership.dispose();
    await f.close();
  }
});

test("bounded progress streams coalesce and completed retention evicts only unwatched settled entries", async () => {
  const f = await fixture();
  const ownership = createInstallOwnership(f.host);
  const owner = ownership.bind(authority().value);

  try {
    const first = await owner.start(f.request);
    await f.started.promise;
    const streams = await Promise.all(Array.from({ length: 8 }, () => owner.watch(first.jobId)));
    await rejects(owner.watch(first.jobId), { reason: "queue-full" });

    for (const stream of streams) await stream.dispose();
    const completed = await owner.watch(first.jobId);
    f.finish.resolve();
    await terminal(completed.updates);
    await completed.dispose();

    for (let index = 0; index < 34; index++) {
      const job = await owner.start(f.request);
      const replay = await owner.watch(job.jobId);
      await terminal(replay.updates);
      await replay.dispose();
    }

    expect(owner.stats().retained).toBeLessThanOrEqual(32);
    await rejects(owner.watch(first.jobId), { reason: "not-owner" });
    expect(ownership.stats().streams).toBe(0);
    expect(f.stats().downloads).toBe(1);
  } finally {
    await ownership.dispose();
    await f.close();
  }
});

test("pending explicit grants count toward bounded consumer admission and disposal releases all slots", async () => {
  const f = await fixture();
  const ownership = createInstallOwnership(f.host);
  const grant = latch();

  const a = ownership.bind({
    ...authority("a").value,
    authorize: async () => {
      await grant.promise;
    },
  });

  const b = ownership.bind({
    ...authority("b").value,
    authorize: async () => {
      await grant.promise;
    },
  });

  const c = ownership.bind(authority("c").value);

  const starts = Array.from({ length: 64 }, (_, index) =>
    (index < 32 ? a : b).start(f.request).catch((cause: unknown) => cause)
  );

  try {
    throws(() => c.start(f.request), { reason: "queue-full" });
    expect(ownership.stats().consumers).toBe(64);
    await ownership.dispose();
    expect((await Promise.all(starts)).every(Schema.is(LanguageError))).toBe(true);
    expect(ownership.stats()).toMatchObject({ owners: 0, consumers: 0, streams: 0, retained: 0 });
    expect(f.stats().downloads).toBe(0);
  } finally {
    grant.resolve();
    await ownership.dispose();
    await f.close();
  }
});
