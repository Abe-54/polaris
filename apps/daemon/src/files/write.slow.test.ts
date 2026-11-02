import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  chmod,
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangedOnDisk, EDITOR_FILE_MAX_BYTES, FileContent, FileError } from "@polaris/protocol";
import { Effect, Exit, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { posixTest } from "../platform/testing.ts";
import { EditorFileRpcs } from "@polaris/protocol";
import { EditorFilesRpcsLive } from "./EditorFilesRpcs.ts";
import { makeFakeBlobChannel } from "./testing.ts";
import { currentVersion, readVersioned } from "./version.ts";
import { createPath, deletePath, renamePath, writeVersioned } from "./write.ts";
import { linuxTrash } from "./trash.ts";
import { inotifyOpen } from "./inotify.ts";
import { openFileWatchCount, watchFile } from "./watch.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "polaris-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

/** Polls until `done` or the deadline; the caller asserts, so a timeout fails there. */
const until = async (done: () => boolean, deadlineMs = 5000) => {
  const start = performance.now();

  while (!done() && performance.now() - start < deadlineMs) await Bun.sleep(5);
};

describe("versioned writes", () => {
  test("concurrent writers and symlink aliases accept exactly one expected version", async () => {
    const path = join(root, "file.ts");
    const alias = join(root, "alias.ts");
    await writeFile(path, "old");
    await symlink(path, alias);
    const expected = (await readVersioned(path)).version;

    const outcomes = await Promise.allSettled([
      writeVersioned(path, bytes("one"), expected),
      writeVersioned(alias, bytes("two"), expected),
    ]);

    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((value) => value.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason instanceof ChangedOnDisk).toBe(true);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["alias.ts", "file.ts"]);
  });

  test("hash catches equal-size edits even when mtime is restored", async () => {
    const path = join(root, "file");
    await writeFile(path, "before");
    await utimes(path, 100, 100);
    const expected = (await readVersioned(path)).version;
    await writeFile(path, "after!");
    await utimes(path, 100, 100);

    try {
      await writeVersioned(path, bytes("overwrite"), expected);
      throw new Error("accepted stale version");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ChangedOnDisk);
    }

    expect(await readFile(path, "utf8")).toBe("after!");
  });

  test("CRLF, BOM, unicode and mode survive a save", async () => {
    const path = join(root, "file.ts");
    await writeFile(path, "\uFEFFold\r\n");
    await chmod(path, 0o751);
    const expected = (await readVersioned(path)).version;
    const text = "\uFEFFconst greeting = 'héllo';\r\n\r\n";
    const version = await writeVersioned(path, bytes(text), expected);
    expect(await readFile(path, "utf8")).toBe(text);

    // Windows keeps no POSIX mode bits to carry over.
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o751);

    expect(version).toEqual((await readVersioned(path)).version);
    expect(version.size).toBe(bytes(text).length);
  });

  test("permission errors do not replace read-only files or leave temps", async () => {
    const path = join(root, "file");
    await writeFile(path, "old");
    await chmod(path, 0o444);
    const expected = (await readVersioned(path)).version;
    await Promise.resolve(expect(writeVersioned(path, bytes("new"), expected)).rejects.toThrow());
    expect(await readFile(path, "utf8")).toBe("old");
    expect(await readdir(root)).toEqual(["file"]);
  });

  test("deleted and dangling symlinks conflict; directories cannot be read as buffers", async () => {
    const path = join(root, "file");
    await writeFile(path, "old");
    const expected = (await readVersioned(path)).version;
    await rm(path);
    await Promise.resolve(
      expect(writeVersioned(path, bytes("new"), expected)).rejects.toMatchObject({
        current: null,
      })
    );
    await symlink(path, join(root, "alias"));
    await Promise.resolve(
      expect(writeVersioned(join(root, "alias"), bytes("new"), expected)).rejects.toMatchObject({
        current: null,
      })
    );
    await Promise.resolve(expect(readVersioned(root)).rejects.toThrow());
  });

  test("large reads and blob writes preserve exact bytes over the RPC", async () => {
    const path = join(root, "big.ts");
    const text = "const hello = '世界';\r\n".repeat(250000);
    await writeFile(path, text);
    const blobs = makeFakeBlobChannel();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(EditorFileRpcs);
          const read = yield* client["files.readVersioned"]({ path });

          const content = FileContent.cases.Blob.make({
            blobId: blobs.put(bytes(text + "// end\r\n")),
          });

          const version = yield* client["files.write"]({ path, expected: read.version, content });

          const conflict = yield* Effect.exit(
            client["files.write"]({
              path,
              expected: read.version,
              content: FileContent.cases.Inline.make({ text: "stale" }),
            })
          );

          return { read, version, conflict };
        })
      ).pipe(Effect.provide(EditorFilesRpcsLive), Effect.provide(blobs.layer))
    );

    expect(result.read.content._tag).toBe("Blob");
    expect(result.version.size).toBe(bytes(text + "// end\r\n").length);
    expect(Exit.isFailure(result.conflict)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(text + "// end\r\n");
  });
});

test("a file over the editor limit is refused before anything is read or offered", async () => {
  const path = join(root, "huge.log");
  await writeFile(path, "");
  // Sparse: 8 GiB on paper, nothing on disk; reading it whole would exhaust the Daemon.
  await truncate(path, 8 * 1024 ** 3);
  const blobs = makeFakeBlobChannel();

  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(EditorFileRpcs);

        return yield* Effect.flip(client["files.readVersioned"]({ path }));
      })
    ).pipe(Effect.provide(EditorFilesRpcsLive), Effect.provide(blobs.layer))
  );

  expect(error).toBeInstanceOf(FileError);
  expect(error.code).toBe("EFBIG");
  expect(error.message.startsWith("EFBIG: ")).toBe(true);
  expect(blobs.blobs.size).toBe(0);
});

test("a file at the editor limit still opens", async () => {
  const path = join(root, "limit.txt");
  await writeFile(path, "");
  await truncate(path, EDITOR_FILE_MAX_BYTES);

  expect((await readVersioned(path)).version.size).toBe(EDITOR_FILE_MAX_BYTES);
});

test("explorer mutations never clobber a destination and deletion is explicit", async () => {
  const directory = join(root, "directory");
  await createPath(directory, "directory");
  const path = join(directory, "file");
  await createPath(path, "file");
  await Promise.resolve(expect(createPath(path, "file")).rejects.toThrow());
  const target = join(directory, "target");
  await createPath(target, "file");
  await Promise.resolve(expect(renamePath(path, target)).rejects.toThrow());
  await deletePath(target, true);
  await renamePath(path, target);
  expect(await readdir(directory)).toEqual(["target"]);
  await deletePath(directory, true);
  expect(await readdir(root)).toEqual([]);
});

posixTest("no Freedesktop trash on Windows, whose file names can't hold `?`")(
  "Freedesktop trash preserves symlinks and writes recovery metadata",
  async () => {
    const path = join(root, "a #?.ts");
    await symlink(join(root, "missing"), path);
    const data = join(root, "data");
    await linuxTrash(path, data);
    const names = await readdir(join(data, "Trash", "files"));
    expect(names).toHaveLength(1);
    expect((await lstat(join(data, "Trash", "files", names[0]!))).isSymbolicLink()).toBe(true);
    const metadata = await readFile(join(data, "Trash", "info", names[0]! + ".trashinfo"), "utf8");
    expect(metadata).toContain(
      "Path=" + encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F")
    );
  }
);

test("open file watches survive consecutive atomic saves and release their parents", async () => {
  const path = join(root, "file");
  await writeFile(path, "before");
  const versions: Array<string | null> = [];

  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* watchFile(path).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            versions.push(event.version?.hash ?? null);
          })
        ),
        Stream.runDrain,
        Effect.forkScoped
      );

      const wait = (size: number) =>
        Effect.tryPromise({
          try: async () => {
            await until(() => versions.length >= size);
            expect(versions.length).toBeGreaterThanOrEqual(size);
          },
          catch: (cause) => cause,
        });

      yield* wait(1);
      yield* Effect.promise(async () => {
        const expected = (await readVersioned(path)).version;
        await writeVersioned(path, bytes("first"), expected);
      });
      yield* wait(2);
      yield* Effect.promise(async () => {
        await writeVersioned(path, bytes("second"), (await readVersioned(path)).version);
      });
      yield* wait(3);
      yield* Effect.promise(() => deletePath(path, true));
      yield* wait(4);
    })
  );

  await Effect.runPromise(program);
  expect(versions.at(-1)).toBeNull();
  expect(openFileWatchCount()).toBe(0);
  expect(await currentVersion(path)).toBeNull();
}, 30_000);

test("an open file's save read in the same burst as a sibling's still reaches its watch", async () => {
  const path = join(root, "file");
  const sibling = join(root, "sibling");
  await writeFile(path, "before");
  await writeFile(sibling, "before");
  const versions: Array<string | null> = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchFile(path).pipe(
          Stream.tap((event) => Effect.sync(() => void versions.push(event.version?.hash ?? null))),
          Stream.runDrain,
          Effect.forkScoped
        );
        yield* Effect.promise(() => until(() => versions.length >= 1));
        // Back to back, so Bun on Linux reads them together and passes on only the first rename.
        writeFileSync(join(root, "sibling.tmp"), "after");
        renameSync(join(root, "sibling.tmp"), sibling);
        writeFileSync(join(root, "file.tmp"), "after");
        renameSync(join(root, "file.tmp"), path);
        const saved = (yield* Effect.promise(() => readVersioned(path))).version.hash;
        yield* Effect.promise(() => until(() => versions.at(-1) === saved));
        expect(versions.at(-1)).toBe(saved);
      })
    )
  );
}, 15_000);

test.each([".env", "~draft"])(
  "an open %s sees a save, then in-place edits and its deletion",
  async (name) => {
    const path = join(root, name);
    await writeFile(path, "before");
    const versions: Array<string | null> = [];

    const reaches = (hash: string | null) =>
      Effect.promise(async () => {
        await until(() => versions.at(-1) === hash);
        expect(versions.at(-1)).toBe(hash);
      });

    /** Writes in place, as a shell redirect or an editor without atomic saves does. */
    const edit = (text: string) =>
      Effect.promise(async () => {
        writeFileSync(path, text);

        return (await readVersioned(path)).version.hash;
      });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* watchFile(path).pipe(
            Stream.tap((event) =>
              Effect.sync(() => void versions.push(event.version?.hash ?? null))
            ),
            Stream.runDrain,
            Effect.forkScoped
          );
          yield* Effect.promise(() => until(() => versions.length >= 1));

          // The save renames a new inode over the file; later edits write to that inode.
          const saved = yield* Effect.promise(async () =>
            writeVersioned(path, bytes("saved"), (await readVersioned(path)).version)
          );

          yield* reaches(saved.hash);
          yield* reaches(yield* edit("edited in place"));
          yield* reaches(yield* edit("edited again"));
          yield* Effect.promise(() => rm(path));
          yield* reaches(null);
        })
      )
    );
  },
  15_000
);

test("20 open tabs share one parent watcher and cancel all native watches", async () => {
  const paths = Array.from({ length: 20 }, (_, i) => join(root, `file-${i}`));
  await Promise.all(paths.map((path) => writeFile(path, "text")));
  let initial = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        for (const path of paths) {
          yield* watchFile(path).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                initial++;
              })
            ),
            Stream.runDrain,
            Effect.forkScoped
          );
        }

        yield* Effect.promise(async () => {
          for (let i = 0; i < 100 && initial < 20; i++) await Bun.sleep(10);
          expect(initial).toBe(20);
          expect(openFileWatchCount()).toBe(1);
          await Bun.sleep(100);
          expect(initial).toBe(20);
        });
      })
    )
  );
  expect(openFileWatchCount()).toBe(0);
  // On Linux the last watch also closes the inotify instance, whose reader holds the event loop.
  expect(inotifyOpen()).toBe(false);
});

posixTest("windows-latest never reports a retargeted symlink, though Windows 11 does (ENG-318)")(
  "symlink watches follow target changes and retargeting",
  async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    const link = join(root, "link");
    await writeFile(first, "first");
    await writeFile(second, "second");
    await symlink(first, link);
    const hashes: Array<string | null> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* watchFile(link).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                hashes.push(event.version?.hash ?? null);
              })
            ),
            Stream.runDrain,
            Effect.forkScoped
          );

          const wait = (count: number) =>
            Effect.promise(async () => {
              for (let i = 0; i < 100 && hashes.length < count; i++) await Bun.sleep(10);
              expect(hashes.length).toBeGreaterThanOrEqual(count);
            });

          yield* wait(1);
          yield* Effect.promise(() => writeFile(first, "changed"));
          yield* wait(2);
          yield* Effect.promise(async () => {
            await rm(link);
            await symlink(second, link);
          });
          yield* wait(3);
          yield* Effect.promise(() => writeFile(second, "again"));
          yield* wait(4);
        })
      )
    );
    expect(hashes.at(-1)).toBe((await readVersioned(second)).version.hash);
    expect(openFileWatchCount()).toBe(0);
  }
);

posixTest("no mkfifo on Windows, whose named pipes aren't in the file system")(
  "named pipes fail promptly as non-files",
  async () => {
    const path = join(root, "pipe");
    const child = Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);

    const outcome = await readVersioned(path).then(
      () => null,
      (cause: unknown) => cause
    );

    expect(outcome).toMatchObject({ code: "ENOTFILE" });
  }
);

test("atomic saves work for long file names", async () => {
  const path = join(root, "x".repeat(240));
  await writeFile(path, "old");
  await writeVersioned(path, bytes("new"), (await readVersioned(path)).version);
  expect(await readFile(path, "utf8")).toBe("new");
});
