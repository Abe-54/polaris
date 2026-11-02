import { expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTempDir, removeRetrying, removeTempDir } from "./tempDir.testing.ts";

const failure = (code: string) => Object.assign(new Error(code), { code });

/** The code a removal failed with, or null when it succeeded. */
const codeOf = (removal: Promise<void>) =>
  removal.then(
    () => null,
    (cause: NodeJS.ErrnoException) => cause.code
  );

/** A remover that fails with `codes` in turn, then removes for real. */
const flaky = (codes: ReadonlyArray<string>) => {
  const pending = [...codes];
  let calls = 0;

  return {
    remove: (path: string) => {
      calls++;
      const code = pending.shift();

      if (code !== undefined) throw failure(code);
      removeTempDir(path);
    },
    calls: () => calls,
  };
};

test("a temp directory is a real path under the OS temp directory, never a literal /tmp", () => {
  const directory = newTempDir("polaris-temp-check-");

  try {
    expect(directory.startsWith(join(realpathSync.native(tmpdir()), "polaris-temp-check-"))).toBe(
      true
    );
  } finally {
    removeTempDir(directory);
  }
});

test.each(["EBUSY", "EPERM", "ENOTEMPTY"])(
  "removal outlasts %s while the directory is busy",
  async (code) => {
    const directory = newTempDir("polaris-temp-busy-");
    writeFileSync(join(directory, "held"), "");
    const remover = flaky([code, code, code]);

    await removeRetrying(directory, remover.remove, [1, 1, 1, 1]);

    expect(existsSync(directory)).toBe(false);
    expect(remover.calls()).toBe(4);
  }
);

test("removal gives up once the backoff runs out, and never retries other errors", async () => {
  const directory = newTempDir("polaris-temp-stuck-");

  try {
    const busy = flaky(["EBUSY", "EBUSY", "EBUSY"]);
    expect(await codeOf(removeRetrying(directory, busy.remove, [1, 1]))).toBe("EBUSY");
    expect(busy.calls()).toBe(3);

    const denied = flaky(["EACCES"]);
    expect(await codeOf(removeRetrying(directory, denied.remove, [1, 1]))).toBe("EACCES");
    expect(denied.calls()).toBe(1);
  } finally {
    removeTempDir(directory);
  }
});
