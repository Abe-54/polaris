import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the preload removes temporary contents and retains the Windows MSYS mount root", () => {
  const dir = mkdtempSync(join(tmpdir(), "preload-cleanup-"));
  const receipt = join(dir, "root.txt");
  const fixture = join(dir, "cleanup.test.ts");

  try {
    writeFileSync(
      fixture,
      `import { test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("creates temporary contents", () => {
  const root = tmpdir();
  writeFileSync(${JSON.stringify(receipt)}, root);
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "secret.txt"), "temporary secret");
  writeFileSync(join(root, "file.txt"), "temporary file");
});
`
    );

    const child = Bun.spawnSync(
      [process.execPath, "test", "--preload", join(import.meta.dir, "tmpdir.ts"), fixture],
      { cwd: dir, stdout: "pipe", stderr: "pipe" }
    );

    expect(child.exitCode).toBe(0);
    const root = readFileSync(receipt, "utf8");
    expect(root).not.toBe(tmpdir());

    if (process.platform === "win32") {
      expect(existsSync(root)).toBe(true);
      expect(readdirSync(root)).toEqual([]);
      rmSync(root, { recursive: true });
    } else {
      expect(existsSync(root)).toBe(false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the preload points POLARIS_HOME inside the run's root and drops the session's Daemon socket and id", () => {
  const dir = mkdtempSync(join(tmpdir(), "preload-home-"));
  const rootReceipt = join(dir, "root.txt");
  const receipt = join(dir, "env.json");
  const fixture = join(dir, "home.test.ts");
  const callerHome = join(dir, "real-home");

  try {
    writeFileSync(
      fixture,
      `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
test("reads the environment", () => {
  const { POLARIS_HOME, POLARIS_HOST_SOCKET, POLARIS_SESSION_ID } = process.env;
  writeFileSync(${JSON.stringify(rootReceipt)}, tmpdir());
  writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ POLARIS_HOME, POLARIS_HOST_SOCKET, POLARIS_SESSION_ID }));
});
`
    );

    const child = Bun.spawnSync(
      [process.execPath, "test", "--preload", join(import.meta.dir, "tmpdir.ts"), fixture],
      {
        cwd: dir,
        env: {
          ...process.env,
          POLARIS_HOME: callerHome,
          POLARIS_HOST_SOCKET: join(callerHome, "daemon.sock"),
          POLARIS_SESSION_ID: "a-real-session",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    expect(child.exitCode).toBe(0);
    const root = readFileSync(rootReceipt, "utf8");

    expect(readFileSync(receipt, "utf8")).toBe(
      JSON.stringify({ POLARIS_HOME: join(root, "polaris-home") })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
