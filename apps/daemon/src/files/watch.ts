import { watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FileError, type FileVersion } from "@polaris/protocol";
import { Cause, Effect, Option, Queue, Stream } from "effect";
import { FileSearch } from "./FileSearch.ts";
import { resolveHostPath, toFsFailure } from "./fs.ts";
import { inotifyAvailable, watchDirectory } from "./inotify.ts";
import { currentVersion, sameVersion } from "./version.ts";

interface Listener {
  readonly name?: string;
  readonly changed: (path: string) => void;
  readonly failed: (cause: unknown) => void;
  /** The settle recheck, when it can be cheaper than `changed`. */
  readonly recheck?: () => void;
}

interface DirectoryWatch {
  readonly close: () => void;
  readonly listeners: Set<Listener>;
  readonly settle: Settle;
}

const directories = new Map<string, DirectoryWatch>();

/** Quiet time after a directory's last event before all its listeners recheck (ADR 0046). */
export const SETTLE_MS = 20;

interface Settle {
  readonly arm: () => void;
  readonly cancel: () => void;
}

// Bun drops an event read within 1 ms of another on the same watcher; anything it dropped
// happened before this timer fires, so one recheck per burst catches it.
const settler = (directory: string, listeners: Set<Listener>): Settle => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    timer = undefined;

    for (const item of listeners)
      if (item.recheck) item.recheck();
      else item.changed(join(directory, item.name ?? ""));
  };

  return {
    arm: () => {
      clearTimeout(timer);
      timer = setTimeout(run, SETTLE_MS);
      timer.unref();
    },
    cancel: () => clearTimeout(timer),
  };
};

/** One native watch on `directory`'s entries; `name` is null for the directory itself. */
const openDirectory = (
  directory: string,
  changed: (name: string | null) => void,
  failed: (cause: unknown) => void
): (() => void) => {
  // Bun's Linux fs.watch drops `.env`, `~draft` and the like (ADR 0047).
  if (inotifyAvailable())
    return watchDirectory(directory, { changed: (_event, name) => changed(name) });

  // The Daemon listener owns process lifetime, including while tabs are open.
  const watcher = watch(directory, { persistent: false }, (_event, filename) =>
    changed(filename?.toString() || null)
  );

  watcher.on("error", failed);

  return () => watcher.close();
};

/** Shared parent watches survive atomic replacements; idle watches run no timer. */
const subscribe = (path: string, listener: Listener): (() => void) => {
  const directory = dirname(path);
  let entry = directories.get(directory);

  if (!entry) {
    const listeners = new Set<Listener>();
    const settle = settler(directory, listeners);

    const close = openDirectory(
      directory,
      (name) => {
        for (const item of listeners)
          if (!name || item.name === undefined || name === item.name)
            item.changed(join(directory, name ?? ""));
        settle.arm();
      },
      (cause) => {
        for (const item of listeners) item.failed(cause);
      }
    );

    entry = { close, listeners, settle };
    directories.set(directory, entry);
  }

  const current = entry;
  current.listeners.add(listener);

  return () => {
    current.listeners.delete(listener);

    if (current.listeners.size === 0) {
      current.settle.cancel();
      current.close();
      directories.delete(directory);
    }
  };
};

/** Shared directory notifications, including creation and atomic directory replacements. */
export const subscribeDirectoryChanges = (directory: string, changed: (path: string) => void) =>
  subscribe(join(directory, ".polaris-directory-interest"), {
    changed,
    failed: () => changed(directory),
  });

/** Identity and change times; never throws, so a failed stat compares as its error code. */
const statKey = (path: string): Promise<string> =>
  stat(path).then(
    (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`,
    (cause: unknown) => `error:${toFsFailure(path, cause).code}`
  );

/** Diagnostic count for watcher lifecycle tests and benchmarks. */
export const openFileWatchCount = () => directories.size;

export const watchFile = (input: string) => {
  const path = resolveHostPath(input);

  return Stream.callback<{ path: string; version: FileVersion | null }, FileError>(
    (queue) =>
      Effect.gen(function* () {
        const watchedPath = yield* Effect.tryPromise({
          try: async () => join(await realpath(dirname(path)), basename(path)),
          catch: (cause) => {
            const error = toFsFailure(path, cause);

            return new FileError({ path, code: error.code, message: error.message });
          },
        });

        const fail = (cause: unknown) => {
          const error = toFsFailure(path, cause);
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(new FileError({ path, code: error.code, message: error.message }))
          );
        };

        let closed = false;
        let running = false;
        let pending = false;
        let initialized = false;
        let last: FileVersion | null = null;
        let stopTarget = () => {};

        let target: string | null = null;
        let seen: string | null = null;

        const changed = () => {
          pending = true;

          if (running || closed) return;
          running = true;
          void (async () => {
            while (pending && !closed) {
              pending = false;
              const nextTarget = await realpath(path).catch(() => null);

              if (closed) return;

              if (target !== nextTarget) {
                stopTarget();
                target = nextTarget;
                stopTarget =
                  target && target !== watchedPath
                    ? subscribe(target, listener(basename(target)))
                    : () => {};
              }

              seen = await statKey(path);
              const version = await currentVersion(path);

              if (!closed && (!initialized || !sameVersion(version, last))) {
                initialized = true;
                last = version;
                Queue.offerUnsafe(queue, { path, version });
              }
            }
          })()
            .catch(fail)
            .finally(() => {
              running = false;

              if (pending && !closed) changed();
            });
        };

        // `seen` is taken before each read, so an unchanged stat means that read saw this content.
        const recheck = () =>
          void statKey(path).then((key) => {
            if (key !== seen) changed();
          });

        const listener = (name: string): Listener => ({ name, changed, failed: fail, recheck });

        yield* Effect.acquireRelease(
          Effect.try({
            try: () => subscribe(watchedPath, listener(basename(path))),
            catch: (cause) => {
              const error = toFsFailure(path, cause);

              return new FileError({ path, code: error.code, message: error.message });
            },
          }),
          (stop) =>
            Effect.sync(() => {
              closed = true;
              stop();
              stopTarget();
            })
        );
        const search = yield* Effect.serviceOption(FileSearch);

        if (Option.isSome(search)) {
          yield* search.value
            .watchIndexedFile(watchedPath, changed)
            .pipe(Effect.catch(() => Effect.void));
        }

        changed();
      }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
    { bufferSize: 1, strategy: "sliding" }
  );
};
