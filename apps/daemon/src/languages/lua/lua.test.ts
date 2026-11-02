import { describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { catalog } from "../catalog/index.ts";
import { luaLaunch } from "./launch.ts";
import { luaPlugin, luaServerSettings } from "./settings.ts";
import { posixTest } from "../../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const posixModes = posixTest(
  "the state directory's privacy is POSIX mode 0700; Windows needs ACL checks (ENG-314)"
);

const withDirectory = async (body: (root: string) => Promise<void>) => {
  const root = newTempDir("polaris-lua-");

  try {
    await body(root);
  } finally {
    await removeTempDirSettled(root);
  }
};

const tool = catalog.tools.find((entry) => entry.id === "lua-language-server")!;

const facts = (root: string, workspaceTrusted: boolean) => ({
  projectRoot: root,
  workspaceTrusted,
});

describe("lua-language-server", () => {
  test("a verified runtime download of 3.19.1 with no Prerequisite", () => {
    expect(tool.distribution).toBe("runtime-upstream");
    expect(tool.requirements).toEqual([]);
    expect(tool.artifacts.map((artifact) => artifact.audit)).toEqual(
      tool.artifacts.map(() => "verified")
    );
    expect(
      tool.artifacts.every((artifact) =>
        artifact.url.startsWith(
          "https://github.com/LuaLS/lua-language-server/releases/download/3.19.1/"
        )
      )
    ).toBe(true);
  });

  test("a .luarc plugin is found as text and asks for Trust; other settings don't", () =>
    withDirectory(async (root) => {
      expect(await luaPlugin(root, root)).toBeNull();
      await writeFile(join(root, ".luarc.json"), '{ "diagnostics.globals": ["vim"] }');
      expect(await luaPlugin(root, root)).toBeNull();
      await writeFile(join(root, ".luarc.json"), '{ "runtime.plugin": "plugin.lua" }');
      expect(await luaPlugin(root, root)).toBe(join(root, ".luarc.json"));
      await writeFile(join(root, ".luarc.json"), '{ "runtime": { "plugin": ["a.lua"] } }');
      expect(await luaPlugin(root, root)).toBe(join(root, ".luarc.json"));
    }));

  posixModes(
    "the Trust split: the Client trusts the plugin only after Trust; state stays outside the install",
    () =>
      withDirectory(async (root) => {
        const installed = { identity: "lua", directory: join(root, "tools/lua/v1") };

        const before = await luaLaunch(facts(root, false), installed);
        const after = await luaLaunch(facts(root, true), installed);

        expect(before.launch.initializationOptions).toEqual({ trustByClient: false });
        expect(after.launch.initializationOptions).toEqual({ trustByClient: true });
        expect(before.launch.executable).toBe(join(installed.directory, "bin/lua-language-server"));
        expect(before.launch.args).toEqual([
          `--logpath=${join(root, "tools/state/log")}`,
          `--metapath=${join(root, "tools/state/meta")}`,
        ]);
        expect((await stat(join(root, "tools/state/log"))).mode & 0o777).toBe(0o700);
      })
  );

  test("telemetry off and no third-party library prompts", () => {
    expect(luaServerSettings().Lua).toMatchObject({
      telemetry: { enable: false },
      workspace: { checkThirdParty: "Disable" },
    });
  });
});
