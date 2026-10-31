import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedLaunchOptions, scriptedLocalInstall } from "./electron.ts";

test("the script launch guard cannot be disabled by the caller's environment", () => {
  expect(
    scriptedLaunchOptions({ args: ["fixture"], env: { POLARIS_DESKTOP_SCRIPTED: "0" } })
  ).toEqual({ args: ["fixture"], env: { POLARIS_DESKTOP_SCRIPTED: "1" } });
  expect(scriptedLaunchOptions({}).env?.POLARIS_DESKTOP_SCRIPTED).toBe("1");
});

test("install smoke preflight refuses to proceed without a separate opt-in", () => {
  expect(() => scriptedLocalInstall("/tmp/sx-install", {})).toThrow(
    "POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL=1"
  );
});

test("every Playwright Electron script uses the guarded launcher", () => {
  const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");
  const unguarded: string[] = [];

  for (const entry of readdirSync(scripts, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const path = join(entry.parentPath, entry.name);
    const source = readFileSync(path, "utf8");

    if (relative(scripts, path) === join("lib", "electron.ts")) continue;

    const imports = [
      ...source.matchAll(
        /import\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*["']playwright(?:-core)?["']/g
      ),
    ];

    const importsRuntime = imports.some(
      (match) =>
        match[1] === undefined &&
        !match[2]!
          .replace(/[{}]/g, "")
          .split(",")
          .filter((name) => name.trim() !== "")
          .every((name) => name.trim().startsWith("type "))
    );

    const guarded =
      /import\s*\{[^}]*scriptedElectron as electron[^}]*\}\s*from\s*["'](?:\.\.?\/)*(?:lib\/)?electron\.ts["']/.test(
        source
      );

    if (
      importsRuntime ||
      /(?:import|require)\s*\(["']playwright(?:-core)?["']\)/.test(source) ||
      (/\belectron\.launch\(/.test(source) && !guarded)
    )
      unguarded.push(relative(scripts, path));
  }

  expect(unguarded).toEqual([]);
});
