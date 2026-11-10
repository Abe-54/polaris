/**
 * Each session's agent-browser config, `{ "cdp": <relay URL> }` in a private file: the URL reaches
 * agent-browser without argv or an env var that the agent's commands would inherit.
 */
import { SessionId } from "@polaris/protocol";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, type Scope, Semaphore } from "effect";
import { writePrivateFile } from "../../platform/windowsNative.ts";

export interface ConfigFiles {
  /** Writes `data` to `path` atomically, readable only by the user. */
  readonly write: (path: string, data: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly list: (dir: string) => Promise<ReadonlyArray<string>>;
}

/** A fresh, exclusively created staging file renamed into place; removed if the rename fails. */
const writePosix = async (path: string, data: string) => {
  const staging = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(staging, data, { mode: 0o600, flag: "wx" });

  try {
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
};

/** On Windows modes don't make a private ACL; `writePrivateFile` sets a user-only DACL. */
export const realConfigFiles: ConfigFiles = {
  write: async (path, data) =>
    process.platform === "win32" ? writePrivateFile(path, data) : writePosix(path, data),
  remove: (path) => rm(path, { force: true }),
  list: (dir) => readdir(dir).catch(() => []),
};

/** A live session's fresh relay URL, or null when its config should go. */
export type RefreshUrl = (sessionId: SessionId) => Effect.Effect<string | null>;

const CONFIG = /^(.+)\.json$/;

/**
 * Held while any open of the session needs it; the last release removes the file. One lock
 * covers write, count and delete, so a release can't delete a config a newer open just wrote.
 * Sessions open only once the Daemon lock is held, so no other process owns these files:
 * `restore` (at Daemon start) rewrites live sessions' files with fresh URLs and removes the rest;
 * without it the first write sweeps them all.
 */
export const sessionConfigs = (dir: string, files: ConfigFiles = realConfigFiles) => {
  const holders = new Map<SessionId, number>();
  const lock = Semaphore.makeUnsafe(1);
  let swept = false;
  const pathOf = (sessionId: SessionId) => join(dir, `${encodeURIComponent(sessionId)}.json`);

  const write = (path: string, cdpUrl: string) =>
    files.write(path, `${JSON.stringify({ cdp: cdpUrl })}\n`);

  const sweep = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });

    if (swept) return;
    await Promise.all((await files.list(dir)).map((name) => files.remove(join(dir, name))));
    swept = true;
  };

  const restoreOne = (name: string, refresh: RefreshUrl) =>
    Effect.gen(function* () {
      const path = join(dir, name);
      const match = CONFIG.exec(name);

      const url =
        match?.[1] === undefined
          ? null
          : yield* refresh(SessionId.make(decodeURIComponent(match[1])));

      if (url === null) yield* Effect.promise(() => files.remove(path).catch(() => {}));
      else yield* Effect.tryPromise(() => write(path, url));
    });

  const restore = (refresh: RefreshUrl) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (swept) return;
        const names = yield* Effect.promise(() => files.list(dir));
        yield* Effect.forEach(names, (name) => restoreOne(name, refresh), { discard: true });
        swept = true;
      })
    );

  const acquire = (sessionId: SessionId, cdpUrl: string) =>
    Effect.tryPromise(async () => {
      await sweep();
      const path = pathOf(sessionId);
      await write(path, cdpUrl);
      holders.set(sessionId, (holders.get(sessionId) ?? 0) + 1);

      return path;
    });

  const release = (sessionId: SessionId) =>
    Effect.promise(async () => {
      const left = (holders.get(sessionId) ?? 1) - 1;

      if (left > 0) return void holders.set(sessionId, left);
      await files.remove(pathOf(sessionId)).catch(() => {});
      holders.delete(sessionId);
    });

  const hold = (
    sessionId: SessionId,
    cdpUrl: string
  ): Effect.Effect<string, unknown, Scope.Scope> =>
    Effect.acquireRelease(lock.withPermits(1)(acquire(sessionId, cdpUrl)), () =>
      lock.withPermits(1)(release(sessionId))
    );

  return { hold, restore };
};
