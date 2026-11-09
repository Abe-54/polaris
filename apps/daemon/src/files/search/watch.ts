import { existsSync, watch as fsWatch } from "node:fs";
import { opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import { findRepoRoot, runGit } from "../../git/git.ts";
import { nativeWatchesChanged, nativeWatchesLive, onNativeWatchesRebuilt } from "../fsevents.ts";
import { inotifyAvailable, watchDirectory } from "../inotify.ts";

export const WALK_SKIP = new Set([".git", "node_modules", ".hg", ".svn"]);

export const WATCH_MAX_DIRECTORIES = 256;

const WATCH_MAX_ENTRIES = 4096;

type Changed = (event: string, path: string) => void;

/** Opens one native watch and returns its stop function. */
type OpenWatch = (path: string, recursive: boolean, changed: Changed) => () => void;

const openWatch: OpenWatch = (path, recursive, changed) => {
  // Bun's Linux fs.watch drops names starting with `.` or `~` (ADR 0047).
  if (!recursive && inotifyAvailable())
    return watchDirectory(path, {
      changed: (event, name) => {
        if (name !== null) changed(event, join(path, name));
      },
    });

  const watcher = fsWatch(path, { recursive }, (event, name) => {
    if (name !== null) changed(event, join(path, name.toString()));
  });

  // Home directories can hold sockets that Bun reports as ENXIO error events.
  watcher.on("error", () => undefined);

  return () => {
    watcher.close();
    nativeWatchesChanged();
  };
};

/**
 * One native tree watch on macOS and Windows; bounded tree watches elsewhere, with non-git
 * roots only on explicit demand.
 */
export const watchRoot = async (
  root: string,
  changed: Changed,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly open?: OpenWatch;
    readonly includeNonGit?: boolean;
  } = {}
): Promise<() => void> => {
  // On Windows a watch per directory spawns a git check-ignore each and keeps it from deletion.
  const platform = options.platform ?? process.platform;
  const recursive = ["darwin", "win32"].includes(platform);
  const open = options.open ?? openWatch;
  const watchers = new Map<string, () => void>();
  let stopped = false;
  let inRepo = false;
  let entries = 0;
  let scanning = Promise.resolve();
  const pending = new Set<string>();
  let stopRescan = () => {};

  const stop = () => {
    stopped = true;
    stopRescan();

    for (const close of watchers.values()) close();
    watchers.clear();
  };

  const ignored = async (path: string) => {
    const result = await runGit(root, ["check-ignore", "--no-index", "-q", "--", path + "/"], {
      okCodes: [1],
      timeoutMs: 1000,
    });

    return result.code === 0;
  };

  const visit = async (directory: string): Promise<Array<string>> => {
    if (stopped || ++entries > WATCH_MAX_ENTRIES) return [];

    if (directory !== root && (watchers.has(directory) || (inRepo && (await ignored(directory)))))
      return [];
    const children: Array<string> = [];

    try {
      const dir = await opendir(directory);

      if (stopped) {
        await dir.close();

        return [];
      }

      for await (const entry of dir) {
        if (stopped || ++entries > WATCH_MAX_ENTRIES) break;

        if (entry.isDirectory() && !WALK_SKIP.has(entry.name))
          children.push(join(directory, entry.name));
      }

      if (!stopped && entries <= WATCH_MAX_ENTRIES && !watchers.has(directory)) arm(directory);
    } catch {
      // Directories may disappear or become unreadable during discovery.
    }

    return children;
  };

  const scan = async (start: string) => {
    const queue = [start];

    while (
      !stopped &&
      queue.length > 0 &&
      watchers.size < WATCH_MAX_DIRECTORIES &&
      entries < WATCH_MAX_ENTRIES
    ) {
      queue.push(...(await visit(queue.shift()!)));
    }
  };

  const enqueue = (path: string) => {
    if (stopped || watchers.size >= WATCH_MAX_DIRECTORIES || entries >= WATCH_MAX_ENTRIES) return;

    if (pending.has(path) || pending.size >= WATCH_MAX_DIRECTORIES) return;
    pending.add(path);
    scanning = scanning
      .then(() => scan(path))
      .catch(() => undefined)
      .finally(() => pending.delete(path));
  };

  const arm = (directory: string) => {
    const close = open(directory, recursive, (event, path) => {
      // Bun's tree watch on Windows reports its own deleted root every 2 ms, forever.
      if (platform === "win32" && !existsSync(directory)) {
        close();
        watchers.delete(directory);
        changed("rename", directory);

        return;
      }

      if (
        relative(root, path)
          .split(/[\\/]/)
          .some((part) => WALK_SKIP.has(part))
      )
        return;
      changed(event, path);

      if (!recursive && event === "rename") enqueue(path);
    });

    watchers.set(directory, close);
  };

  try {
    if (recursive) arm(root);
    else inRepo = (await findRepoRoot(root)) !== null;

    // The native tree watch already covers it; a scan would arm a second one per directory.
    if (!recursive && (inRepo || options.includeNonGit)) {
      scanning = scan(root);
      await scanning;
    }

    // Callers read the tree next, so what changes after this must already be reported.
    await nativeWatchesLive();

    // A rebuild for another watch may drop this one's changes: report the root, as a rescan.
    if (platform === "darwin" && !stopped)
      stopRescan = onNativeWatchesRebuilt(() => changed("rename", root));

    return stop;
  } catch (cause) {
    stop();
    throw cause;
  }
};
