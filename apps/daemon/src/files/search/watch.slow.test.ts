import { afterEach, expect, test } from "bun:test";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { makeRepo, removeDir, tempDir, write } from "../../git/testing.ts";
import { posixTest } from "../../platform/testing.ts";
import { WATCH_MAX_DIRECTORIES, watchRoot } from "./watch.ts";

const roots: Array<string> = [];

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();

  for (const root of roots.splice(0)) removeDir(root);
});

const recorder = () => {
  const opened: Array<{ path: string; recursive: boolean }> = [];

  const open: NonNullable<NonNullable<Parameters<typeof watchRoot>[2]>["open"]> = (
    path,
    recursive,
    changed
  ) => {
    opened.push({ path, recursive });

    const watcher = watch(path, { recursive: false }, (event, name) => {
      if (name !== null) changed(event, join(path, name.toString()));
    });

    return () => watcher.close();
  };

  return { opened, open };
};

test("on Windows a tree watch whose root is deleted closes instead of reporting it forever", async () => {
  const root = tempDir("polaris-gone-watch-");
  let reports = 0;
  let closed = false;

  // As Bun's recursive watch does on Windows once its root is gone.
  const open: NonNullable<NonNullable<Parameters<typeof watchRoot>[2]>["open"]> = (
    path,
    _recursive,
    changed
  ) => {
    const spin = setInterval(() => existsSync(path) || changed("rename", path), 2);

    return () => {
      closed = true;
      clearInterval(spin);
    };
  };

  stops.push(await watchRoot(root, () => reports++, { platform: "win32", open }));
  removeDir(root);
  await Bun.sleep(100);

  expect(closed).toBe(true);
  expect(reports).toBe(1);
});

test("a large non-git Workspace never registers a native tree watch on Linux", async () => {
  const root = tempDir("polaris-home-watch-");
  roots.push(root);

  for (let i = 0; i < WATCH_MAX_DIRECTORIES + 100; i++) {
    write(root, `.cache/uv/archive-v0/${i}/lib/python3.11/site-packages/cachetools/a.py`, "pass");
  }

  const { opened, open } = recorder();
  const stop = await watchRoot(root, () => undefined, { platform: "linux", open });
  stops.push(stop);
  expect(opened).toEqual([]);
});

posixTest(
  "Linux's bounded watch spawns a git check-ignore per directory, ~45 s for this tree on Windows"
)(
  "git watches are capped and never ask the runtime to recurse",
  async () => {
    const root = await makeRepo();
    roots.push(root);

    for (let i = 0; i < WATCH_MAX_DIRECTORIES + 10; i++) write(root, `src/${i}/a.ts`, "");
    const { opened, open } = recorder();
    stops.push(await watchRoot(root, () => undefined, { platform: "linux", open }));
    expect(opened).toHaveLength(WATCH_MAX_DIRECTORIES);
    expect(opened.every((entry) => !entry.recursive)).toBe(true);
  },
  20_000
);

test("a huge flat git directory is not handed to Bun's native enumerator", async () => {
  const root = await makeRepo();
  roots.push(root);

  for (let i = 0; i < 4100; i++) write(root, `file-${i}`, "");
  const { opened, open } = recorder();
  stops.push(await watchRoot(root, () => undefined, { platform: "linux", open }));
  expect(opened).toEqual([]);
});

test("git watches skip ignored directories, metadata and node_modules", async () => {
  const root = await makeRepo({ ".gitignore": "build/\n", "src/nested/a.ts": "" });
  roots.push(root);
  write(root, "build/deep/a.js", "");
  write(root, "node_modules/deep/a.js", "");
  const { opened, open } = recorder();
  stops.push(await watchRoot(root, () => undefined, { platform: "linux", open }));
  expect(opened.map((entry) => entry.path).sort()).toEqual(
    [root, join(root, "src"), join(root, "src/nested")].sort()
  );
});

test("bounded git watches report nested changes and discover new directories", async () => {
  const root = await makeRepo({ "src/a.ts": "" });
  roots.push(root);
  const seen: Array<string> = [];
  const { opened, open } = recorder();

  const stop = await watchRoot(root, (_event, path) => seen.push(path), {
    platform: "linux",
    open,
  });

  stops.push(stop);
  write(root, "src/a.ts", "changed");
  await waitFor(() => seen.includes(join(root, "src/a.ts")));
  write(root, "src/new/nested/a.ts", "new");
  await waitFor(() => opened.some((entry) => entry.path === join(root, "src/new/nested")));
  // A discovered directory's watch isn't probed (only Linux discovers, and inotify has no gap).
  await waitFor(() => {
    write(root, "src/new/nested/a.ts", `changed ${seen.length}`);

    return seen.includes(join(root, "src/new/nested/a.ts"));
  });
  stop();
  const count = opened.length;
  write(root, "src/after/a.ts", "");
  await Bun.sleep(100);
  expect(opened).toHaveLength(count);
});

test("bounded git watches report dotfiles and discover dotted directories", async () => {
  const root = await makeRepo({ ".env": "A=1" });
  roots.push(root);
  const seen: Array<string> = [];
  stops.push(await watchRoot(root, (_event, path) => seen.push(path), { platform: "linux" }));
  write(root, ".env", "A=2");
  await waitFor(() => seen.includes(join(root, ".env")));
  write(root, ".github/workflows/ci.yml", "on: push");
  await waitFor(() => seen.includes(join(root, ".github")));
  // Discovery arms `.github` and then `workflows` asynchronously; keep editing until it lands.
  await waitFor(() => {
    write(root, ".github/workflows/ci.yml", `on: [push] # ${seen.length}`);

    return seen.includes(join(root, ".github/workflows/ci.yml"));
  });
});

// Bun on macOS restarts its one FSEvents stream after a watch opens or closes (ADR 0072).
test.skipIf(process.platform !== "darwin")(
  "a file created as soon as a watch is armed beside a busy one is reported",
  async () => {
    const busy = tempDir("polaris-busy-watch-");
    roots.push(busy);
    stops.push(await watchRoot(busy, () => undefined));
    const missed: Array<number> = [];

    // Without the probe about a third of these creations are never reported.
    for (let i = 0; i < 20; i++) {
      for (let k = 0; k < 1000; k++) write(busy, `${k}.ts`, String(i));
      const root = tempDir("polaris-armed-watch-");
      roots.push(root);
      const seen: Array<string> = [];
      const stop = await watchRoot(root, (_event, path) => seen.push(path));
      write(root, "created.ts", "");
      await waitFor(() => seen.includes(join(root, "created.ts"))).catch(() => missed.push(i));
      stop();
    }

    expect(missed).toEqual([]);
  },
  60_000
);

test("macOS keeps its single native recursive FSEvents watch", async () => {
  const root = tempDir("polaris-mac-watch-");
  roots.push(root);
  const { opened, open } = recorder();
  stops.push(await watchRoot(root, () => undefined, { platform: "darwin", open }));
  expect(opened).toEqual([{ path: root, recursive: true }]);
});

test("macOS keeps one watch even when non-git roots are asked for", async () => {
  const root = tempDir("polaris-mac-watch-");
  roots.push(root);
  write(root, "nested/deeper/a.ts", "");
  const { opened, open } = recorder();
  stops.push(
    await watchRoot(root, () => undefined, { platform: "darwin", open, includeNonGit: true })
  );
  expect(opened).toEqual([{ path: root, recursive: true }]);
});

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Bun.sleep(20);
  }

  throw new Error("watch notification missing");
};

test("explicit language demand watches non-git Linux checkout configs without recursion", async () => {
  const root = tempDir("polaris-language-watch-");
  roots.push(root);
  write(root, "nested/tsconfig.json", "{}");
  const { opened, open } = recorder();
  const seen: string[] = [];
  stops.push(
    await watchRoot(root, (_event, path) => seen.push(path), {
      platform: "linux",
      open,
      includeNonGit: true,
    })
  );
  expect(opened.map((entry) => entry.path)).toContain(join(root, "nested"));
  expect(opened.every((entry) => !entry.recursive)).toBe(true);
  await waitFor(() => {
    write(root, "nested/tsconfig.json", `{"compilerOptions":{"strict":true}} // ${seen.length}`);

    return seen.includes(join(root, "nested/tsconfig.json"));
  });
  expect(seen).toContain(join(root, "nested/tsconfig.json"));
});
