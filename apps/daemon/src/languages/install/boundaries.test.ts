import { expect } from "bun:test";
import { rejects } from "node:assert/strict";
import { symlink, mkdir, writeFile, readFile, readdir, stat, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Effect, Schema } from "effect";
import { HostId } from "@polaris/protocol";
import { createInstaller } from "./index.ts";
import { ManagedInstaller } from "./service.ts";
import { artifactFixture, fixture, hostId, platform } from "./fixture.testing.ts";
import { packagedFiles, packagedRoot } from "../catalog/packaging.ts";
import { digest } from "./validation.ts";
import type { ArtifactPayload, ExactArtifact } from "./types.ts";
import { posixTest } from "../../platform/testing.ts";

const test = posixTest(
  "language storage is checked private by POSIX owner and mode bits; Windows needs ACL checks (ENG-314)"
);

function packagedFixture() {
  const f = artifactFixture();

  const entries: ArtifactPayload["entries"] = [
    ...f.payload.entries,
    { path: "meta/template/core", kind: "file", mode: 0o644, bytes: Buffer.from("fake-template") },
    { path: "meta/3rd/excluded", kind: "file", mode: 0o644, bytes: Buffer.from("fake-excluded") },
  ];

  const files = packagedFiles(entries);
  const root = packagedRoot(files);

  const manifest = Buffer.from(
    JSON.stringify({
      filter: "lua-core-v1",
      sourceIntegrity: digest(f.bytes),
      postFilterIntegrity: root,
      files,
    })
  );

  const tool = {
    ...f.tool,
    artifacts: f.tool.artifacts.map((a) => ({
      ...a,
      packaging: {
        filter: "lua-core-v1",
        sourceIntegrity: a.integrity,
        manifest: "packaging.json",
        manifestIntegrity: digest(manifest),
        postFilterIntegrity: root,
        disableThirdPartyDiscovery: true,
      },
    })),
  };

  return {
    ...f,
    tool,
    payload: {
      ...f.payload,
      entries,
      packagingManifestBytes: manifest,
      thirdPartyDiscovery: false,
    },
  };
}

test("filtered packaging verifies pinned output, excludes only declared tree and retains notices", async () => {
  const p = packagedFixture();

  const f = await fixture({
    async decode() {
      return p.payload;
    },
  });

  try {
    const installed = await f.installer.install({ ...f.request, tool: p.tool }).result;
    expect(await readFile(join(installed.directory, "LICENSE"))).toEqual(
      Buffer.from(p.payload.entries[1]!.bytes)
    );
    expect(await readdir(join(installed.directory, "meta"))).toEqual(["template"]);
    expect((await stat(join(installed.directory, "bin/tool"))).mode & 0o777).toBe(0o755);
    await chmod(join(installed.directory, "bin/tool"), 0o700);
    await rejects(f.installer.current("fake-tool"));
  } finally {
    await f.close();
  }

  for (const mutate of [
    (payload: typeof p.payload) => ({
      ...payload,
      entries: payload.entries.map((entry) =>
        entry.path === "bin/tool" ? { ...entry, bytes: Buffer.from("mutated-output") } : entry
      ),
    }),
    (payload: typeof p.payload) => ({ ...payload, thirdPartyDiscovery: true }),
    (payload: typeof p.payload) => ({ ...payload, packagingManifestBytes: Buffer.from("bad") }),
    (payload: typeof p.payload) => ({
      ...payload,
      entries: [
        ...payload.entries,
        {
          path: "meta/3rd/link",
          kind: "symlink" as const,
          mode: 0o777,
          bytes: Buffer.from("../../escape"),
        },
      ],
    }),
  ]) {
    const f = await fixture({
      async decode() {
        return mutate(p.payload);
      },
    });

    try {
      await rejects(f.installer.install({ ...f.request, tool: p.tool }).result);
      expect(await f.debris()).toEqual([]);
    } finally {
      await f.close();
    }
  }
});

test("job/waiter/listener limits, conflicting version/metadata and cancellation guard admission", async () => {
  const f = await fixture(
    {
      async decode() {
        return new Promise(() => {});
      },
    },
    { jobs: 1, waiters: 2, listeners: 1 }
  );

  try {
    const off = f.installer.subscribe(() => {});
    expect(() => f.installer.subscribe(() => {})).toThrow();
    off();
    const a = f.installer.install(f.request);
    const b = f.installer.install(f.request);
    const observed = Promise.all([rejects(a.result), rejects(b.result)]);
    expect(() => f.installer.install(f.request)).toThrow();
    expect(() =>
      f.installer.install({ ...f.request, tool: artifactFixture("2.0.0").tool, intent: "update" })
    ).toThrow();
    expect(() =>
      f.installer.install({ ...f.request, tool: { ...f.source.tool, developerCompanions: [] } })
    ).toThrow();
    expect(() =>
      f.installer.install({ ...f.request, tool: { ...f.source.tool, id: "another" } })
    ).toThrow();
    a.cancel();
    b.cancel();
    expect(() => f.installer.install(f.request)).toThrow();
    await observed;
    await f.installer.dispose();
    expect(f.installer.stats()).toMatchObject({ jobs: 0, waiters: 0, listeners: 0 });
    expect(await f.debris()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("descriptor key order deduplicates; caller and adapters cannot mutate authoritative approval identity", async () => {
  const f = await fixture({
    async approve(exact) {
      Object.assign(exact.tool, { version: "forged" });
      Object.assign(exact.descriptor, { developerCompanions: [] });

      return { approved: true, identity: exact.identity };
    },
  });

  try {
    const first = f.installer.install(f.request);
    const reordered = Object.fromEntries(Object.entries(f.source.tool).reverse());
    const second = f.installer.install({ ...f.request, tool: reordered });
    expect(first.jobId).toBe(second.jobId);
    f.source.tool.version = "caller-mutated";
    const [one, two] = await Promise.all([first.result, second.result]);
    expect(one).toEqual(two);
    expect(one.version).toBe("1.0.0");
    expect(one.descriptor.developerCompanions).toEqual([
      { id: "future-developer", required: true },
    ]);
  } finally {
    await f.close();
  }
});

test("session barrier rejects version switch and retains working installation", async () => {
  let source = artifactFixture();
  let busy = false;

  const f = await fixture({
    async *download() {
      yield source.bytes;
    },
    async decode() {
      return source.payload;
    },
    async beforeSelect() {
      if (busy) throw new Error("tool in use");
    },
  });

  try {
    const one = await f.installer.install(f.request).result;
    busy = true;
    source = artifactFixture("2.0.0");
    await rejects(
      f.installer.install({ ...f.request, tool: source.tool, intent: "update" }).result
    );
    expect((await f.installer.current("fake-tool"))?.identity).toBe(one.identity);
    expect(await f.debris()).toEqual([]);
    busy = false;
    expect(
      (await f.installer.install({ ...f.request, tool: source.tool, intent: "update" }).result)
        .version
    ).toBe("2.0.0");
  } finally {
    await f.close();
  }
});

test("private roots reject permissions/symlinks/other Hosts; cross-instance lock is fail-closed", async () => {
  let release = () => {};

  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const f = await fixture({
    async decode() {
      await hold;

      return artifactFixture().payload;
    },
  });

  try {
    const adapters = {
      async *download() {
        yield f.source.bytes;
      },
      async decode() {
        return f.source.payload;
      },
      async approve(exact: ExactArtifact) {
        return { approved: true, identity: exact.identity };
      },
    };

    await mkdir(join(f.parent, "public"), { mode: 0o755 });
    await rejects(createInstaller({ root: join(f.parent, "public"), hostId, platform, adapters }));
    await symlink(join(f.parent, "private"), join(f.parent, "link"));
    await rejects(createInstaller({ root: join(f.parent, "link"), hostId, platform, adapters }));
    await rejects(
      createInstaller({
        root: join(f.parent, "private"),
        hostId: HostId.make("00000000-0000-4000-8000-000000000002"),
        platform,
        adapters,
      })
    );

    const other = await createInstaller({
      root: join(f.parent, "private"),
      hostId,
      platform,
      adapters,
    });

    let entered = () => {};

    const downloading = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const off = f.installer.subscribe((progress) => {
      if (progress.phase === "downloading") entered();
    });

    const first = f.installer.install(f.request);
    await downloading;
    await rejects(other.install(f.request).result);
    release();
    await first.result;
    off();
    await other.dispose();
    expect(await f.debris()).toEqual([]);
  } finally {
    release();
    await f.close();
  }
});

test("stored file links and modified receipt descriptors are rejected, never launch certificates", async () => {
  const f = await fixture();

  try {
    const one = await f.installer.install(f.request).result;
    const receiptPath = join(dirname(one.directory), "receipt.json");
    const original = await readFile(receiptPath);

    const receipt = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ descriptor: Schema.JsonObject }))
    )(original.toString("utf8"));

    expect(receipt.descriptor.developerCompanions).toEqual(f.source.tool.developerCompanions);

    const serialized = original
      .toString("utf8")
      .replace(JSON.stringify(f.source.tool.developerCompanions), "[]");

    await writeFile(receiptPath, serialized);
    await rejects(f.installer.current("fake-tool"));
    await writeFile(receiptPath, original);
    const external = join(f.parent, "external");
    await writeFile(external, "unchanged");
    const payloadLink = join(one.directory, "bin/link");
    await symlink(external, payloadLink);
    await rejects(f.installer.current("fake-tool"));
  } finally {
    await f.close();
  }
});

test("ManagedInstaller.layer without an approve adapter fails the install", async () => {
  const f = await fixture();

  try {
    const layer = ManagedInstaller.layer({
      root: join(f.parent, "effect"),
      hostId,
      platform,
      adapters: {
        async *download() {
          yield f.source.bytes;
        },
        async decode() {
          return f.source.payload;
        },
      },
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ManagedInstaller;

        return yield* service.install(f.request);
      }).pipe(Effect.flip, Effect.provide(layer))
    );

    expect(error).toMatchObject({
      reason: "audit-required",
      message: "Exact artifact approval required",
    });
  } finally {
    await f.close();
  }
});

test("download cancellation abandons late pure adapter results and invokes iterator cleanup", async () => {
  let entered = () => {};

  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  let release = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  let returned = false;

  const f = await fixture({
    async *download() {
      try {
        entered();
        await held;
        yield artifactFixture().bytes;
      } finally {
        returned = true;
      }
    },
  });

  try {
    const handle = f.installer.install(f.request);
    const observed = rejects(handle.result);
    await started;
    handle.cancel();
    await observed;
    await f.installer.dispose();
    expect(await f.debris()).toEqual([]);
    release();
    await held;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(true);
    expect(await f.installer.current("fake-tool")).toBe(null);
  } finally {
    release();
    await f.close();
  }
});

test("physical implicit directories, chunk count and prefix aliases are bounded before writes", async () => {
  const aliases: ArtifactPayload["entries"] = [
    ...artifactFixture().payload.entries,
    { path: "BIN/other", kind: "file", mode: 0o644, bytes: Buffer.from("case") },
  ];

  const f = await fixture({
    async decode() {
      return { ...artifactFixture().payload, entries: aliases };
    },
  });

  try {
    await rejects(f.installer.install(f.request).result);
    expect(await f.debris()).toEqual([]);
  } finally {
    await f.close();
  }

  const g = await fixture(
    {
      async decode() {
        return {
          ...artifactFixture().payload,
          entries: [
            ...artifactFixture().payload.entries,
            { path: "a/b/c/d/e/file", kind: "file", mode: 0o644, bytes: Buffer.from("deep") },
          ],
        };
      },
    },
    { entries: 4 }
  );

  try {
    await rejects(g.installer.install(g.request).result);
    expect(await g.debris()).toEqual([]);
  } finally {
    await g.close();
  }

  const h = await fixture(
    {
      async *download() {
        for (let i = 0; i < 10; i++) yield new Uint8Array();
      },
    },
    { entries: 4 }
  );

  try {
    await rejects(h.installer.install(h.request).result);
    expect(h.counts().decodes).toBe(0);
  } finally {
    await h.close();
  }
});

test("retained version cap rejects updates without pruning a working version", async () => {
  let source = artifactFixture();

  const f = await fixture(
    {
      async *download() {
        yield source.bytes;
      },
      async decode() {
        return source.payload;
      },
    },
    { versions: 1 }
  );

  try {
    const one = await f.installer.install(f.request).result;
    source = artifactFixture("2.0.0");
    await rejects(
      f.installer.install({ ...f.request, tool: source.tool, intent: "update" }).result
    );
    expect((await f.installer.current("fake-tool"))?.identity).toBe(one.identity);
    expect((await f.installer.versions("fake-tool")).length).toBe(1);
    expect(await f.debris()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("filtering cannot discard a notice required by the pinned source audit", async () => {
  const p = packagedFixture();
  const excluded = p.payload.entries.find((entry) => entry.path === "meta/3rd/excluded")!;

  const manifestBytes = Buffer.from(
    JSON.stringify({
      artifactId: "fake",
      artifactIntegrity: digest(p.bytes),
      coverage: "complete",
      notices: [
        { path: "LICENSE", integrity: digest(p.payload.entries[1]!.bytes) },
        { path: excluded.path, integrity: digest(excluded.bytes) },
      ],
    })
  );

  const tool = {
    ...p.tool,
    artifacts: p.tool.artifacts.map((a) => ({ ...a, auditRoot: digest(manifestBytes) })),
  };

  const f = await fixture({
    async decode() {
      return { ...p.payload, manifestBytes };
    },
  });

  try {
    await rejects(f.installer.install({ ...f.request, tool }).result);
    expect(f.counts().downloads).toBe(1);
    expect(await f.installer.current("fake-tool")).toBe(null);
    expect(await f.debris()).toEqual([]);
  } finally {
    await f.close();
  }
});
