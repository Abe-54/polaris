import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { materializeInstrumentation } from "./assets.ts";
import { instrumentationPlugin } from "./build.ts";

test("partial extracted assets are repaired and only the newest three builds remain", async () => {
  const home = await mkdtemp("/tmp/uf11-assets-");

  try {
    const assets = { "register.mjs": "export {};", "sdk.cjs": "module.exports = {};" };
    const register = await materializeInstrumentation(assets, home);
    await writeFile(register, "partial");
    await writeFile(join(dirname(register), "sdk.cjs"), "partial");
    await materializeInstrumentation(assets, home);
    expect(await readFile(register, "utf8")).toBe(assets["register.mjs"]);
    expect(await readFile(join(dirname(register), "sdk.cjs"), "utf8")).toBe(assets["sdk.cjs"]);
    const paths = [];

    for (let version = 0; version < 4; version++) {
      paths.push(
        await materializeInstrumentation(
          { "register.mjs": `export const version = ${version};` },
          home
        )
      );
      await Bun.sleep(10);
    }

    expect(await Bun.file(register).exists()).toBe(false);
    expect(await Bun.file(paths[0]!).exists()).toBe(false);
    expect(await Promise.all(paths.slice(1).map((path) => Bun.file(path).exists()))).toEqual([
      true,
      true,
      true,
    ]);
    expect(await readdir(join(home, "node-instrumentation"))).toHaveLength(3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an embedding build that misses embedded.ts is rejected", async () => {
  const root = await mkdtemp("/tmp/uf11-embedding-");

  try {
    const entry = join(root, "entry.ts");
    await writeFile(entry, "console.log('missing assets');");
    const plugin = await instrumentationPlugin();
    const result = await Bun.build({ entrypoints: [entry], plugins: [plugin] });
    expect(result.success).toBe(true);
    expect(() => plugin.assertEmbedded()).toThrow("embedding plugin did not run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
