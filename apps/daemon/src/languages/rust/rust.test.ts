import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { catalog } from "../catalog/index.ts";
import { Schema } from "effect";
import { rustLaunch, type RustFacts } from "./launch.ts";
import { managedRustLuaSettings } from "./settings.ts";
import { rustToolchainProbes } from "./probes.ts";
import { rustCrates } from "./project.ts";
import { findRustToolchain } from "./toolchain.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

const withDirectory = async (body: (root: string) => Promise<void>) => {
  const root = newTempDir("polaris-rust-");

  try {
    await body(root);
  } finally {
    await removeTempDirSettled(root);
  }
};

const put = async (root: string, path: string, text = "", mode = 0o644) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
  await chmod(join(root, path), mode);

  return join(root, path);
};

/** A rustup home with one toolchain; its binaries would leave a marker if anything ran them. */
const rustup = async (root: string, components: { rustfmt?: boolean; src?: boolean } = {}) => {
  const toolchain = "toolchains/stable-aarch64-apple-darwin";
  const marker = `#!/bin/sh\ntouch ${root}/RAN\n`;
  await put(root, "rustup/settings.toml", 'default_toolchain = "stable"\n');
  await put(root, `rustup/${toolchain}/bin/cargo`, marker, 0o755);
  await put(root, `rustup/${toolchain}/bin/rustc`, marker, 0o755);

  if (components.rustfmt !== false)
    await put(root, `rustup/${toolchain}/bin/rustfmt`, marker, 0o755);

  if (components.src !== false)
    await mkdir(join(root, `rustup/${toolchain}/lib/rustlib/src/rust/library`), {
      recursive: true,
    });

  return join(root, "rustup", toolchain);
};

const options = (root: string) => ({
  home: root,
  rustupHome: join(root, "rustup"),
  directories: [],
  settingsFallbacks: [],
});

const tool = catalog.tools.find((entry) => entry.id === "rust-analyzer")!;

describe("catalog pins", () => {
  test("rust-analyzer is a verified runtime download with the toolchain as a Prerequisite", () => {
    expect(tool.distribution).toBe("runtime-upstream");
    expect(tool.artifacts.map((artifact) => artifact.audit)).toEqual(
      tool.artifacts.map(() => "verified")
    );
    expect(
      tool.artifacts.every((artifact) =>
        artifact.url.startsWith(
          "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/"
        )
      )
    ).toBe(true);
    expect(tool.requirements.map((requirement) => [requirement.id, requirement.required])).toEqual([
      ["cargo", true],
      ["rust-src", false],
      ["rustfmt", false],
    ]);
  });
});

describe("Prerequisite detection", () => {
  test("reads rustup's default toolchain without running anything, and Check again sees an install", () =>
    withDirectory(async (root) => {
      expect(await rustToolchainProbes(tool.requirements, options(root))).toEqual([
        { id: "cargo", executable: null, version: null },
        { id: "rust-src", executable: null, version: null },
        { id: "rustfmt", executable: null, version: null },
      ]);

      const sysroot = await rustup(root, { src: false });
      const probes = await rustToolchainProbes(tool.requirements, options(root));

      expect(probes.map((probe) => [probe.id, probe.executable])).toEqual([
        ["cargo", join(sysroot, "bin/cargo")],
        ["rust-src", null],
        ["rustfmt", join(sysroot, "bin/rustfmt")],
      ]);
      expect(await Bun.file(join(root, "RAN")).exists()).toBe(false);
    }));

  test("a default named without its host triple, a Homebrew fallback file, or no default", () =>
    withDirectory(async (root) => {
      await rustup(root);
      await put(root, "rustup/settings.toml", 'version = "12"\n');
      await put(root, "fallback.toml", 'default_toolchain = "stable"\n');

      expect(await findRustToolchain(options(root))).toBeNull();
      expect(
        (
          await findRustToolchain({
            ...options(root),
            settingsFallbacks: [join(root, "fallback.toml")],
          })
        )?.cargo
      ).toBe(join(root, "rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo"));
    }));
});

describe("the project before Trust", () => {
  test("crates come from Cargo.toml: the library, binaries and path dependencies", () =>
    withDirectory(async (root) => {
      await put(
        root,
        "Cargo.toml",
        '[package]\nname = "my-app"\nedition = "2021"\n\n[dependencies]\nutil = { path = "util" }\nserde = "1"\n'
      );
      await put(root, "src/lib.rs");
      await put(root, "src/main.rs");
      await put(root, "src/bin/tool.rs");
      await put(root, "util/Cargo.toml", '[package]\nname = "util"\nedition = "2024"\n');
      await put(root, "util/src/lib.rs");
      await put(root, "../outside/Cargo.toml", '[package]\nname = "outside"\n');

      const crates = await rustCrates(root, root);

      expect(crates.map((crate) => [crate.display_name, crate.edition])).toEqual([
        ["my_app", "2021"],
        ["util", "2024"],
        ["my_app", "2021"],
      ]);
      expect(crates[0]?.deps).toEqual([{ crate: 1, name: "util" }]);
      expect(crates[2]?.deps).toEqual([
        { crate: 1, name: "util" },
        { crate: 0, name: "my_app" },
      ]);
      expect(crates.every((crate) => !crate.root_module.includes("outside"))).toBe(true);
    }));
});

const facts = (root: string, workspaceTrusted: boolean): RustFacts => ({
  projectRoot: root,
  workspaceTrusted,
  providerId: "rust-analyzer",
  managedRustLua: true,
  effectiveSettings: { settings: {} },
  rustCrates: [],
});

const installed = (root: string) => ({
  identity: "rust",
  directory: join(root, "tools/rust-analyzer/v1"),
});

describe("the Trust split", () => {
  test("before Trust: no build scripts, proc-macros or check, the Host toolchain by path, a private project", () =>
    withDirectory(async (root) => {
      const sysroot = await rustup(root);

      const plan = await rustLaunch(facts(root, false), installed(root), () =>
        findRustToolchain(options(root))
      );

      const init = plan.launch.initializationOptions!;

      expect(init).toMatchObject({
        cargo: { buildScripts: { enable: false } },
        procMacro: { enable: false },
        checkOnSave: false,
      });
      expect(plan.launch.environment).toMatchObject({
        PATH: join(sysroot, "bin"),
        CARGO: join(sysroot, "bin/cargo"),
        RUSTC: join(sysroot, "bin/rustc"),
        RUSTFMT: join(sysroot, "bin/rustfmt"),
      });

      const [project] = Schema.decodeUnknownSync(Schema.Tuple([Schema.String]))(
        init.linkedProjects
      );

      expect(project.startsWith(join(root, "tools"))).toBe(true);
      expect(JSON.parse(await readFile(project, "utf8"))).toMatchObject({
        sysroot,
        crates: [],
      });
      expect(managedRustLuaSettings(facts(root, false), plan.launch)).toEqual({
        "rust-analyzer": init,
      });
    }));

  test("after Trust: the normal configuration and the project's own toolchain", () =>
    withDirectory(async (root) => {
      await rustup(root);

      const plan = await rustLaunch(facts(root, true), installed(root), () =>
        findRustToolchain(options(root))
      );

      expect(plan.launch.initializationOptions).toEqual({});
      expect(plan.launch.environment).not.toHaveProperty("CARGO");
    }));

  test("without a toolchain the launch fails on the missing Prerequisite", () =>
    withDirectory(async (root) => {
      const error = await rustLaunch(facts(root, false), installed(root), () =>
        findRustToolchain(options(root))
      ).catch((cause: unknown) => cause);

      expect(error).toMatchObject({ reason: "missing-prerequisite" });
    }));
});
