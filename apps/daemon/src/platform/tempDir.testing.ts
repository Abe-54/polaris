/**
 * Test helpers: throwaway directories under the OS temp directory, removed with retries.
 * Not used at runtime. Every Daemon test makes its temp directories here.
 */
import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

const windows = process.platform === "win32";

/** Codes a removal may outgrow: Windows keeps a file busy until whoever had it open lets go. */
const BUSY = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/** Waits between attempts: about 6 s in all, long enough for a stopped Daemon or SQLite to let go. */
const BACKOFF_MS = [10, 25, 50, 100, 200, 400, 400, 400, 400, 400, 400, 800, 800, 800, 800];

export interface TempDirOptions {
  /**
   * A short root for Unix socket paths (~104 bytes on macOS): `/tmp` on macOS and Linux,
   * the OS temp directory on Windows, which has no `/tmp` and names pipes instead.
   */
  readonly short?: boolean;
}

const rootOf = (options: TempDirOptions) =>
  options.short === true && !windows ? "/tmp" : tmpdir();

const retryable = (cause: unknown) =>
  // SAFETY: rmSync throws only Node system errors, which carry a string `code`.
  BUSY.has((cause as NodeJS.ErrnoException).code ?? "");

type Remove = (path: string) => void;

const removeNow: Remove = (path) => rmSync(path, { recursive: true, force: true });

/** Calls `remove` until it succeeds, waiting `delays` in turn while it fails as busy. */
export const removeRetrying = async (
  path: string,
  remove: Remove = removeNow,
  delays: ReadonlyArray<number> = BACKOFF_MS
): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      remove(path);

      return;
    } catch (cause) {
      const delay = delays[attempt];

      if (delay === undefined || !retryable(cause)) throw cause;
      await Bun.sleep(delay);
    }
  }
};

/** Removes `path` and everything under it, retrying while it's busy; blocks the event loop. */
export const removeTempDir = (path: string): void => {
  for (let attempt = 0; ; attempt++) {
    try {
      removeNow(path);

      return;
    } catch (cause) {
      const delay = BACKOFF_MS[attempt];

      if (delay === undefined || !retryable(cause)) throw cause;
      Bun.sleepSync(delay);
    }
  }
};

/**
 * Removal that lets the event loop run between attempts, so a child a test started
 * (a Daemon, git, a shell) can exit and let go of the directory (ENG-356).
 */
export const removeTempDirSettled = (path: string): Promise<void> => removeRetrying(path);

/**
 * A new directory, its real path (Windows' 8.3 names such as RUNNER~1 expanded, macOS's
 * /var as /private/var). The caller removes it with `removeTempDir`.
 */
export const newTempDir = (prefix = "polaris-test-", options: TempDirOptions = {}): string =>
  realpathSync.native(mkdtempSync(join(rootOf(options), prefix)));

/** A directory removed after the calling test. */
export const tempDir = (prefix = "polaris-test-", options: TempDirOptions = {}): string => {
  const directory = newTempDir(prefix, options);
  // Register in the calling test's context; module-level hooks only cover the importing file.
  afterEach(() => removeTempDirSettled(directory));

  return directory;
};

/** Declare before beforeAll; the returned factory's directories last until the suite ends. */
export const suiteTempDir = (
  prefix = "polaris-test-",
  options: TempDirOptions = {}
): (() => string) => {
  const directories: Array<string> = [];
  afterAll(async () => {
    for (const directory of directories.splice(0)) await removeTempDirSettled(directory);
  });

  return () => {
    const directory = newTempDir(prefix, options);
    directories.push(directory);

    return directory;
  };
};

/** A directory for the enclosing Scope, removed when it closes. */
export const scopedTempDir = (prefix = "polaris-test-", options: TempDirOptions = {}) =>
  Effect.acquireRelease(
    Effect.sync(() => newTempDir(prefix, options)),
    (directory) => Effect.promise(() => removeTempDirSettled(directory))
  );
