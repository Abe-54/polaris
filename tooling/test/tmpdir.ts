/**
 * Test preload: each `bun test` run gets its own temp root, swept on exit,
 * so helpers that `mkdtempSync(tmpdir())` without cleanup can't fill /tmp.
 * POLARIS_HOME always points inside it, whatever the caller exported (an Agent Session exports
 * the real `~/.polaris`), and the session's Daemon socket and id are dropped (ENG-826).
 */
import { afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "polaris-test-run-"));

process.env.TMPDIR = root;

// Windows' tmpdir() reads TEMP and TMP, never TMPDIR.
if (process.platform === "win32") {
  process.env.TEMP = root;
  process.env.TMP = root;
}

process.env.POLARIS_HOME = join(root, "polaris-home");

for (const name of ["POLARIS_HOST_SOCKET", "POLARIS_SESSION_ID"]) delete process.env[name];

// `--rerun-each` runs the hooks again but not this module: each rerun recreates the root.
beforeAll(() => {
  mkdirSync(root, { recursive: true });
});

// A preload's afterAll runs once, after every test file. Windows may still hold a file
// (EBUSY, EPERM): retry, then leave it, as a CI runner is discarded anyway.
afterAll(() => {
  try {
    // MSYS shares its /tmp mount across processes, so Windows must retain the empty root.
    const paths =
      process.platform === "win32" ? readdirSync(root).map((name) => join(root, name)) : [root];

    for (const path of paths)
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (cause) {
    if (process.platform !== "win32") throw cause;
    console.warn(`left the test run's temp root ${root}: ${String(cause)}`);
  }
});
