import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShellArgv } from "./run.ts";

const COMMAND = `echo "two  words" 'single quoted' $HOME; printf '%s' "$(pwd)"`;

// The wrapper is POSIX sh, which only runs on the Hosts that use it.
describe.skipIf(process.platform === "win32")("the login shell wrapper", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "polaris-login-shell-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const run = (shell: string, command: string) => {
    const [file = "", ...args] = loginShellArgv(command);

    return Bun.spawnSync([file, ...args], { env: { HOME: home, SHELL: shell } });
  };

  test("the user's shell starts with -lc and gets the command intact, as one argument", () => {
    const seen = join(home, "argv");
    const shell = join(home, "fake-shell");

    writeFileSync(
      shell,
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\0' "$arg"; done > "${seen}"\n`
    );
    chmodSync(shell, 0o755);

    expect(run(shell, COMMAND).exitCode).toBe(0);
    expect(readFileSync(seen, "utf8").split("\0").slice(0, -1)).toEqual(["-lc", COMMAND]);
  });

  // Empty, not unset: macOS's /bin/sh fills in an unset SHELL before the wrapper reads it.
  test("with an empty SHELL, /bin/sh runs the command", () => {
    const result = run("", `printf '%s' "two  words"`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toEndWith("two  words");
  });
});
