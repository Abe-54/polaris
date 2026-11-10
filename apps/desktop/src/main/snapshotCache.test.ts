import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sequence, Workspace } from "@polaris/protocol";
import { Schema } from "effect";
import type { CachedHost } from "../shared/api.ts";
import { CachedHost as CachedHostSchema } from "../shared/contract.ts";
import { workspace } from "../renderer/store/fixtures.testing.ts";
import { type CacheFiles, openSnapshotCache } from "./snapshotCache.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const userData = () => {
  const dir = mkdtempSync(join(tmpdir(), "polaris-cache-"));

  dirs.push(dir);

  return dir;
};

const host = (hostKey: string, sequence: number): CachedHost => ({
  hostKey,
  sequence: Sequence.make(sequence),
  workspaces: [
    new Workspace({
      id: workspace.id,
      path: workspace.path,
      name: `${hostKey}-${sequence}`,
      isGitRepo: false,
      worktreeRoot: workspace.worktreeRoot,
      hidden: false,
      registeredAt: workspace.registeredAt,
    }),
  ],
  worktrees: [],
  sessions: [],
});

/** What the next launch paints: a fresh cache reading the same directory. */
const relaunch = (dir: string) =>
  openSnapshotCache(dir)
    .get()
    .map((h) => `${h.hostKey}@${h.sequence}`);

const realFiles: CacheFiles = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: (path, text) => writeFile(path, text),
  rename,
};

const never = new Promise<never>(() => undefined);

describe("snapshot cache", () => {
  test("the renderer's last put before quit is on disk in the launch format", async () => {
    const dir = userData();
    const cache = openSnapshotCache(dir);

    cache.put(host("local", 1));
    // The renderer answers later, as over IPC.
    await cache.flushForQuit((id) => {
      // An earlier blur's answer doesn't release the quit.
      cache.rendererFlushed(0);
      setTimeout(() => {
        cache.put(host("local", 2));
        cache.put(host("studio", 7));
        cache.rendererFlushed(id);
      }, 10);
    }, 5000);

    expect(relaunch(dir)).toEqual(["local@2", "studio@7"]);

    const CacheFile = Schema.Struct({
      version: Schema.Literal(1),
      hosts: Schema.Array(CachedHostSchema),
    });

    expect(readFileSync(join(dir, "cache", "hosts.json"), "utf8")).toBe(
      Schema.encodeSync(Schema.fromJsonString(CacheFile))({
        version: 1,
        hosts: [host("local", 2), host("studio", 7)],
      })
    );
  });

  test("a quit whose renderer never answers still writes what main has", async () => {
    const dir = userData();
    const cache = openSnapshotCache(dir);

    cache.put(host("local", 3));
    await cache.flushForQuit(() => undefined, 50);

    expect(relaunch(dir)).toEqual(["local@3"]);
  });

  test("overlapping puts never write at once, and the last one wins", async () => {
    const dir = userData();
    let open = 0;
    let most = 0;

    const slow: CacheFiles = {
      ...realFiles,
      writeFile: async (path, text) => {
        most = Math.max(most, ++open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await writeFile(path, text);
        open--;
      },
    };

    const cache = openSnapshotCache(dir, { files: slow });

    for (let sequence = 1; sequence <= 5; sequence++) {
      cache.put(host("local", sequence));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    await cache.flush();

    expect(most).toBe(1);
    expect(relaunch(dir)).toEqual(["local@5"]);
  });

  test("a crash between the temp write and the rename leaves the old file readable", async () => {
    const dir = userData();
    const first = openSnapshotCache(dir);

    first.put(host("local", 1));
    await first.flush();

    let wrote = false;

    const crashing = openSnapshotCache(dir, {
      files: {
        ...realFiles,
        writeFile: async (path, text) => {
          await writeFile(path, text);
          wrote = true;
        },
        rename: () => never,
      },
    });

    crashing.put(host("local", 2));

    while (!wrote) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(relaunch(dir)).toEqual(["local@1"]);
  });

  test("a put encodes only its own Host", async () => {
    const dir = userData();
    const seed = openSnapshotCache(dir);

    seed.put(host("local", 1));
    seed.put(host("studio", 1));
    await seed.flush();

    const encoded: Array<string> = [];
    const encode = Schema.encodeSync(Schema.fromJsonString(CachedHostSchema));

    const cache = openSnapshotCache(dir, {
      encodeHost: (h) => {
        encoded.push(h.hostKey);

        return encode(h);
      },
    });

    cache.put(host("local", 2));
    cache.put(host("local", 3));
    await cache.flush();

    expect(encoded).toEqual(["local", "local"]);
    expect(relaunch(dir)).toEqual(["studio@1", "local@3"]);
  });
});
