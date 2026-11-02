import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { FileError } from "@polaris/protocol";
import { Effect, Fiber, Stream } from "effect";
import { makeRepo, removeDir, tempDir, suiteTempDir, write } from "../git/testing.ts";
import { FileSearch, FileSearchLive } from "./FileSearch.ts";
import { handleGrep, handleSearchPaths } from "./FilesRpcs.ts";
import { fuzzyScore, gitGrepThreads } from "./search/fallback.ts";
import { fffWatchTesting } from "./search/fff.ts";
import type { FileChange } from "./search/types.ts";

// Keep fff's frecency databases out of the real ~/.polaris.
let home: string;

const previousHome = process.env.POLARIS_HOME;

const createHome = suiteTempDir("polaris-home-");

beforeAll(() => {
  home = createHome();
  process.env.POLARIS_HOME = home;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.POLARIS_HOME;
  else process.env.POLARIS_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const fixture = async () => {
  const root = await makeRepo({
    ".gitignore": "dist/\n",
    "src/services.ts": "export const BlobChannel = 1\n",
    "src/harness/HarnessDriver.ts": "// drives a Harness\nexport const driver = 'BlobChannel'\n",
    "README.md": "Polaris\n",
  });

  write(root, "src/untracked.ts", "const blobchannel = 2\n");
  write(root, "dist/services.js", "BlobChannel ignored\n");
  cleanup.push(root);

  return root;
};

const withSearch = <A, E>(useFff: boolean, effect: Effect.Effect<A, E, FileSearch>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, FileSearchLive({ useFff }))));

/** Beyond the product's worst case to arm a watch: fff's scan wait plus its watcher wait. */
const ARM_DEADLINE_MS = 15_000;

const waitFor = async (predicate: () => boolean, what: string) => {
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }

  throw new Error(`timed out waiting for ${what}`);
};

/**
 * Writes a new probe file every 25 ms until the watch reports one, so the watch is armed.
 * Each probe is a new path: fff debounces a path for 50 ms, so rewriting one file this fast never reports.
 */
const armWatch = async (root: string, seen: ReadonlyArray<FileChange>, failure: string) => {
  const deadline = Date.now() + ARM_DEADLINE_MS;

  for (let i = 0; !seen.some((c) => c.path.includes(join(root, "src", "probe-"))); i++) {
    if (Date.now() > deadline) throw new Error(failure);
    write(root, `src/probe-${i}.ts`, `${i}\n`);
    await Bun.sleep(25);
  }
};

for (const useFff of [true, false]) {
  const backend = useFff ? "fff" : "fallback";

  describe(`FileSearch (${backend})`, () => {
    test("uses the expected backend", async () => {
      const root = await fixture();

      const kind = await withSearch(
        useFff,
        Effect.gen(function* () {
          const search = yield* FileSearch;
          yield* search.searchPaths(root, "readme", 5);

          return yield* search.backendOf(root);
        })
      );

      expect(kind).toBe(backend);
    });

    test("fuzzy path search finds files and skips ignored ones", async () => {
      const root = await fixture();

      const hits = await withSearch(
        useFff,
        handleSearchPaths({ root, query: "services", limit: 10 })
      );

      const paths = hits.map((h) => h.path);
      expect(paths[0]).toBe(join(root, "src/services.ts"));
      expect(paths).not.toContain(join(root, "dist/services.js"));
    });

    test("search and grep keep each symlink root's spelling on a shared index", async () => {
      const root = await fixture();
      const links = tempDir("polaris-search-links-");
      cleanup.push(links);
      const aliases = [join(links, "workspace"), join(links, "other-workspace")];

      for (const alias of aliases) symlinkSync(root, alias, "dir");

      await withSearch(
        useFff,
        Effect.gen(function* () {
          const search = yield* FileSearch;

          for (const requested of [root, ...aliases, root]) {
            const paths = yield* handleSearchPaths({
              root: requested,
              query: "services",
              limit: 1,
            });

            expect(paths.map((hit) => hit.path)).toEqual([join(requested, "src/services.ts")]);

            const hits = yield* handleGrep({
              root: requested,
              pattern: "BlobChannel",
              regex: false,
              caseSensitive: true,
              limit: 50,
            });

            expect(hits.map((hit) => hit.path).sort()).toEqual(
              ["src/harness/HarnessDriver.ts", "src/services.ts"].map((path) =>
                join(requested, path)
              )
            );
            expect(hits.find((hit) => hit.path.endsWith("services.ts"))).toMatchObject({
              line: 1,
              column: 14,
              text: "export const BlobChannel = 1",
            });
            expect(yield* search.backendOf(requested)).toBe(backend);
          }

          const nested = join(aliases[0]!, "src");
          const paths = yield* handleSearchPaths({ root: nested, query: "services", limit: 1 });
          expect(paths.map((hit) => hit.path)).toEqual([join(nested, "services.ts")]);
        })
      );
    });

    test("grep: plain, case-insensitive and regex, with 1-based columns", async () => {
      const root = await fixture();

      const results = await withSearch(
        useFff,
        Effect.all([
          handleGrep({
            root,
            pattern: "BlobChannel",
            regex: false,
            caseSensitive: true,
            limit: 50,
          }),
          handleGrep({
            root,
            pattern: "BlobChannel",
            regex: false,
            caseSensitive: false,
            limit: 50,
          }),
          handleGrep({
            root,
            pattern: "export const \\w+ =",
            regex: true,
            caseSensitive: true,
            limit: 50,
          }),
          handleGrep({
            root,
            pattern: "BlobChannel",
            regex: false,
            caseSensitive: false,
            limit: 1,
          }),
        ])
      );

      const [sensitive, insensitive, regex, limited] = results;

      const where = (hits: typeof sensitive) =>
        hits.map((h) => h.path.slice(root.length + 1).replaceAll(sep, "/")).sort();

      expect(where(sensitive)).toEqual(["src/harness/HarnessDriver.ts", "src/services.ts"]);
      expect(where(insensitive)).toEqual([
        "src/harness/HarnessDriver.ts",
        "src/services.ts",
        "src/untracked.ts",
      ]);
      expect(where(regex)).toEqual(["src/harness/HarnessDriver.ts", "src/services.ts"]);
      expect(limited).toHaveLength(1);
      const hit = sensitive.find((h) => h.path.endsWith("services.ts"))!;
      expect(hit).toMatchObject({ line: 1, column: 14, text: "export const BlobChannel = 1" });
    });

    test("watch reports created, modified and deleted files", async () => {
      const root = await fixture();
      const seen: Array<FileChange> = [];

      const has = (name: string, kind: FileChange["kind"]) =>
        seen.some((c) => c.path === join(root, name) && c.kind === kind);

      const layer = FileSearchLive({ useFff });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const search = yield* FileSearch;

            const fiber = yield* search.watch(root).pipe(
              Stream.runForEach((batch) => Effect.sync(() => seen.push(...batch))),
              Effect.forkChild
            );

            // Let the watcher arm: fff scans, then waits up to 5 s for its watcher before falling back.
            yield* search.searchPaths(root, "x", 1);
            yield* Effect.promise(() => armWatch(root, seen, "the watcher never armed"));
            yield* Effect.promise(async () => {
              write(root, "src/new.ts", "new\n");
              await waitFor(() => has("src/new.ts", "created"), "created");
              await Bun.sleep(100);
              write(root, "src/new.ts", "changed\n");
              await waitFor(
                () =>
                  has("src/new.ts", "modified") ||
                  seen.filter((c) => c.path.endsWith("new.ts")).length > 1,
                "modified"
              );
              rmSync(join(root, "src/new.ts"));
              await waitFor(() => has("src/new.ts", "deleted"), "deleted");
            });
            yield* Fiber.interrupt(fiber);
          }).pipe(Effect.provide(layer))
        )
      ).catch((error) => {
        throw new Error(`${error}; saw ${JSON.stringify(seen)}`);
      });
    }, 40_000);
  });
}

/** Waits for the idle sweep to drop the index of `root`. */
const dropped = (search: FileSearch["Service"], root: string) =>
  Effect.gen(function* () {
    for (let i = 0; (yield* search.backendOf(root)) !== null; i++) {
      if (i === 200) return yield* Effect.die(new Error(`the index of ${root} was kept`));
      yield* Effect.sleep("10 millis");
    }
  });

describe("FileSearch lifecycle", () => {
  test("watching a missing root fails instead of hanging", async () => {
    const root = join(await fixture(), "not-yet");

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const search = yield* FileSearch;

          return yield* search
            .watch(root)
            .pipe(Stream.runDrain, Effect.timeout("2 seconds"), Effect.flip);
        }).pipe(Effect.provide(FileSearchLive()))
      )
    );

    expect(exit).toBeInstanceOf(FileError);
  });

  test("indexes are dropped when idle and rebuilt lazily", async () => {
    const root = await fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const search = yield* FileSearch;
          expect(yield* search.backendOf(root)).toBeNull();
          yield* search.searchPaths(root, "readme", 1);
          expect(yield* search.backendOf(root)).toBe("fallback");
          yield* dropped(search, root);
          yield* search.searchPaths(root, "readme", 1);
          expect(yield* search.backendOf(root)).toBe("fallback");
        }).pipe(Effect.provide(FileSearchLive({ useFff: false, idleMs: 50, sweepMs: 20 })))
      )
    );
  });

  test("fff's worker starts with the first index and stops with the last", async () => {
    const { fffWorkerRunning } = await import("./search/fff.ts");
    const root = await fixture();
    expect(fffWorkerRunning()).toBe(false);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const search = yield* FileSearch;
          yield* search.searchPaths(root, "readme", 1);
          expect(yield* search.backendOf(root)).toBe("fff");
          expect(fffWorkerRunning()).toBe(true);
          yield* dropped(search, root);
        }).pipe(Effect.provide(FileSearchLive({ idleMs: 50, sweepMs: 20 })))
      )
    );
    await waitFor(() => !fffWorkerRunning(), "the fff worker to stop");
  });

  test("an index with a watcher is kept while idle", async () => {
    const root = await fixture();
    const unwatched = await fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const search = yield* FileSearch;
          const fiber = yield* search.watch(root).pipe(Stream.runDrain, Effect.forkChild);
          // An unwatched index from the same moment going idle shows the sweep has run.
          yield* search.searchPaths(unwatched, "readme", 1);
          yield* dropped(search, unwatched);
          expect(yield* search.backendOf(root)).toBe("fallback");
          yield* Fiber.interrupt(fiber);
          yield* dropped(search, root);
        }).pipe(Effect.provide(FileSearchLive({ useFff: false, idleMs: 50, sweepMs: 20 })))
      )
    );
  });

  test("a root that is a file is ENOTDIR", async () => {
    const root = await fixture();

    const error = await withSearch(
      false,
      Effect.flip(handleSearchPaths({ root: join(root, "README.md"), query: "x", limit: 1 }))
    );

    expect(error).toBeInstanceOf(FileError);
    expect(error.code).toBe("ENOTDIR");
  });

  test("POLARIS_FFF=off forces the fallback", async () => {
    const root = await fixture();
    process.env.POLARIS_FFF = "off";

    try {
      const { loadFff } = await import("./search/fff.ts");
      expect(await loadFff()).toBeNull();
    } finally {
      delete process.env.POLARIS_FFF;
    }

    expect(root).toBeTruthy();
  });
});

describe("fallback fuzzy scorer", () => {
  test("prefers file-name and word-start matches; rejects non-subsequences", () => {
    const services = fuzzyScore("serv", "apps/daemon/src/services.ts")!;
    const buried = fuzzyScore("serv", "some/server-side/very/long/path/x.ts")!;
    expect(services).toBeGreaterThan(buried);
    expect(fuzzyScore("hd", "src/harness/HarnessDriver.ts")).not.toBeNull();
    expect(fuzzyScore("zzz", "src/services.ts")).toBeNull();
  });
});

describe("fallback grep threads", () => {
  test("half the cores (2–8) on macOS, git's default elsewhere", () => {
    expect(gitGrepThreads("darwin", 12)).toBe(6);
    expect(gitGrepThreads("darwin", 4)).toBe(2);
    expect(gitGrepThreads("darwin", 2)).toBe(2);
    expect(gitGrepThreads("darwin", 32)).toBe(8);
    expect(gitGrepThreads("linux", 12)).toBeNull();
  });
});

test("open-file subscriptions reuse an existing fff index without creating one", async () => {
  const root = await fixture();
  const path = join(root, "README.md");
  let notifications = 0;
  await withSearch(
    true,
    Effect.scoped(
      Effect.gen(function* () {
        const search = yield* FileSearch;
        yield* search.watchIndexedFile(path, () => {
          notifications++;
        });
        expect(yield* search.backendOf(root)).toBeNull();
        yield* search.searchPaths(root, "readme", 5);
        expect(yield* search.backendOf(root)).toBe("fff");
        yield* search.watchIndexedFile(path, () => {
          notifications++;
        });
        yield* Effect.promise(async () => {
          write(root, "README.md", "changed\n");
          await waitFor(() => notifications > 0, "indexed open-file change");
        });
      })
    )
  );
  expect(notifications).toBeGreaterThan(0);
}, 20_000);

test("a watch whose fff watcher never arms reports changes through fs.watch", async () => {
  const root = await fixture();
  const seen: Array<FileChange> = [];
  const saved = { ...fffWatchTesting };
  Object.assign(fffWatchTesting, { disableWatch: true, armMs: 100 });

  try {
    await withSearch(
      true,
      Effect.gen(function* () {
        const search = yield* FileSearch;

        const fiber = yield* search.watch(root).pipe(
          Stream.runForEach((batch) => Effect.sync(() => seen.push(...batch))),
          Effect.forkChild
        );

        yield* search.searchPaths(root, "x", 1);
        yield* Effect.promise(async () => {
          await armWatch(root, seen, "the watch never reported a change");
          write(root, "src/new.ts", "new\n");
          await waitFor(
            () => seen.some((c) => c.path === join(root, "src/new.ts") && c.kind === "created"),
            "created"
          );
        });
        expect(yield* search.backendOf(root)).toBe("fff");
        yield* Fiber.interrupt(fiber);
      })
    );
  } finally {
    Object.assign(fffWatchTesting, saved);
  }
}, 20_000);
