import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSizeBudget, treeSize } from "./size.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake `Polaris.app` shaped like Electron's: a framework reached through a symlink. */
const fakeApp = () => {
  const root = mkdtempSync(join(tmpdir(), "polaris-size-test-"));
  dirs.push(root);

  const app = join(root, "Polaris.app");
  const versions = join(app, "Contents/Frameworks/Electron Framework.framework/Versions");
  mkdirSync(join(versions, "A"), { recursive: true });
  writeFileSync(join(versions, "A/Electron Framework"), Buffer.alloc(3000));
  symlinkSync("A", join(versions, "Current"));
  mkdirSync(join(app, "Contents/Resources/daemon/darwin-arm64"), { recursive: true });
  writeFileSync(join(app, "Contents/Resources/daemon/darwin-arm64/polaris"), Buffer.alloc(2000));
  writeFileSync(join(app, "Contents/Resources/app.asar"), Buffer.alloc(500));

  const dmg = join(root, "Polaris.dmg");
  writeFileSync(dmg, Buffer.alloc(1000));

  return { app, dmg };
};

test("an Electron framework's Versions/Current symlink is not counted twice", () => {
  const { app } = fakeApp();

  // 3000 + 2000 + 500 bytes of files; the symlink adds only its own few bytes.
  expect(treeSize(app)).toBeGreaterThanOrEqual(5500);
  expect(treeSize(app)).toBeLessThan(5600);
});

test("a DMG exactly at its budget passes", () => {
  const paths = fakeApp();

  expect(() => checkSizeBudget(paths, { dmgBytes: 1000, appBytes: 6000 })).not.toThrow();
});

test.each([
  ["DMG", { dmgBytes: 999, appBytes: 6000 }],
  ["Polaris.app", { dmgBytes: 1000, appBytes: 5000 }],
])("a %s over budget fails packaging and names where the bytes went", (over, budget) => {
  const paths = fakeApp();

  expect(() => checkSizeBudget(paths, budget)).toThrow(
    new RegExp(`size budget exceeded \\(${over.replace(".", "\\.")}\\)[^]*Resources/daemon`)
  );
});
