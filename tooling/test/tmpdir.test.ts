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
