import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitInstalledDaemon } from "./daemon.ts";

test("waiting for an installed Daemon that never listens says what its log says", async () => {
  const home = mkdtempSync(join(tmpdir(), "polaris-await-"));

  try {
    mkdirSync(join(home, ".polaris", "bin", "current"), { recursive: true });
    writeFileSync(join(home, ".polaris", "bin", "current", "polaris"), "");
    mkdirSync(join(home, ".polaris", "logs"), { recursive: true });
    writeFileSync(join(home, ".polaris", "logs", "daemon.err.log"), "dyld: Library not loaded\n");
    const failed = await awaitInstalledDaemon(join(home, "daemon.sock"), home, 300).catch(String);

    expect(failed).toContain("the daemon didn't start listening within 0.3 s");
    expect(failed).toContain("dyld: Library not loaded");
    expect(failed).not.toContain("\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
