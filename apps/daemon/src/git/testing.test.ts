import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSettled } from "./testing.ts";

// Windows only: elsewhere a process's working directory never blocks its removal.
describe.skipIf(process.platform !== "win32")("removeTempDirSettled", () => {
  test("a child still waiting on this process can finish and let go of the directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "polaris-settle-"));

    const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
      cwd: directory,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });

    // The child exits only once a timer of ours runs, as git does when its stdin is still being fed.
    setTimeout(() => void child.stdin.end(), 300);

    await removeTempDirSettled(directory);

    expect(existsSync(directory)).toBe(false);
    await child.exited;
  });
});
