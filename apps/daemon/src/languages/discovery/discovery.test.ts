import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LanguageEffectiveSettings } from "@polaris/protocol";
import { createProjectDiscovery } from "./index.ts";
import { fixture } from "./fixture.ts";
import { posixTest } from "../../platform/testing.ts";

const posixVenv = posixTest(
  "the fixtures' virtual environments are POSIX bin/python; Windows venvs have Scripts\\python.exe (ENG-296)"
);

for (const executable of ["bin/python3", ".local/share/uv/python/cpython-3.13.5/bin/python3"])
  test(`refresh discovers newly installed Host Python at ${executable} without executing it`, async () => {
    const f = await fixture();

    try {
      const home = join(f.root, "host");
      const path = await f.put("project/main.py");

      const discovery = createProjectDiscovery({
        registry: f.registry,
        pythonHost: { home, directories: [join(home, "bin")] },
      });

      const input = {
        checkout: f.checkout,
        path,
        providerId: "basedpyright",
        settings: f.settings,
      };

      expect((await discovery.discover(input)).interpreter).toBeNull();

      const entry = join(home, executable);

      await mkdir(join(entry, ".."), { recursive: true });
      await writeFile(entry, "#!/bin/sh\necho MUST_NOT_RUN\n", { mode: 0o755 });
      expect((await discovery.discover(input)).interpreter).toBeNull();
      expect((await discovery.discover({ ...input, refresh: true })).interpreter).toBe(entry);
    } finally {
      await f.cleanup();
    }
  });

posixVenv(
  "Sightline topology: alias SDK, JSONC inherited plugins, nested roots, Prisma and Go",
  async () => {
    const f = await fixture();

    try {
      await f.put("package.json", "{}");
      await f.put(
        "apps/web/package.json",
        '{"dependencies":{"typescript":"npm:@typescript/typescript6@6.0.1"}}'
      );
      await f.put(
        "base.json",
        '{"compilerOptions":{"plugins":[{"name":"next"},{"name":"@effect/language-service"},{"name":"workflow"}]}}'
      );
      await f.put(
        "apps/web/tsconfig.json",
        '{// comment\n"extends":"../../base.json", "compilerOptions": {"strict":true,},}'
      );
      const path = await f.put("apps/web/app/page.tsx");
      await f.put(
        "node_modules/.pnpm/alias/node_modules/@typescript/typescript6/package.json",
        '{"name":"@typescript/typescript6","version":"6.0.1"}'
      );
      await f.put(
        "node_modules/.pnpm/alias/node_modules/typescript/package.json",
        '{"name":"typescript","version":"6.0.3"}'
      );

      const server = await f.put(
        "node_modules/.pnpm/alias/node_modules/typescript/lib/tsserver.js",
        'throw new Error("Must never execute")'
      );

      await mkdir(join(f.root, "apps/web/node_modules"), { recursive: true });
      await symlink(
        join(f.root, "node_modules/.pnpm/alias/node_modules/@typescript/typescript6"),
        join(f.root, "apps/web/node_modules/typescript")
      );

      for (const name of ["next", "@effect/language-service", "workflow"]) {
        await f.put(`apps/web/node_modules/${name}/package.json`, JSON.stringify({ name }));
        await f.put(`apps/web/node_modules/${name}/index.js`, 'throw new Error("Plugin executed")');
      }

      const discovery = createProjectDiscovery({ registry: f.registry });

      const ts = await discovery.discover({
        checkout: f.checkout,
        path,
        providerId: "typescript",
        settings: f.settings,
      });

      expect(ts.projectRoot).toBe(join(f.root, "apps/web"));
      expect(ts.tsserver).toBe(server);
      expect(ts.sdkVersion).toBe("6.0.3");
      expect(ts.plugins.map(({ name }) => name)).toEqual([
        "next",
        "@effect/language-service",
        "workflow",
      ]);
      expect(ts.plugins.every(({ packagePath }) => packagePath !== null)).toBe(true);
      expect(ts.pluginProbeRoots).toEqual([join(f.root, "apps/web")]);

      await f.put("services/api/pyproject.toml");
      await f.put("services/api/.venv/bin/python");
      const nestedPython = await f.put("services/api/jobs/.venv/bin/python");
      const pyFile = await f.put("services/api/jobs/main.py");

      const py = await discovery.discover({
        checkout: f.checkout,
        path: pyFile,
        providerId: "pyright",
        settings: f.settings,
      });

      expect(py.projectRoot).toBe(join(f.root, "services/api"));
      expect(py.interpreter).toBe(nestedPython);

      await f.put("Cargo.toml", '[workspace]\nmembers=["native"]');
      await f.put("native/Cargo.toml", '[package]\nname="nested"');
      const rustFile = await f.put("native/src/lib.rs");
      expect(
        (
          await discovery.discover({
            checkout: f.checkout,
            path: rustFile,
            providerId: "rust-analyzer",
            settings: f.settings,
          })
        ).projectRoot
      ).toBe(join(f.root, "native"));

      await f.put(
        "apps/web/prisma.config.ts",
        'throw new Error("Executable Prisma configuration loaded")'
      );
      const schema = await f.put("apps/web/prisma/schema.prisma");

      const prisma = await discovery.discover({
        checkout: f.checkout,
        path: schema,
        providerId: "prisma",
        settings: f.settings,
      });

      expect(prisma.prisma).toEqual({
        config: join(f.root, "apps/web/prisma.config.ts"),
        schema,
        configurationDeferred: true,
      });
      await f.put("go.work", "go 1.26\nuse ./go/service");
      await f.put("go/service/go.mod", "module fixture");
      const go = await f.put("go/service/main.go");

      const facts = await discovery.discover({
        checkout: f.checkout,
        path: go,
        providerId: "gopls",
        settings: f.settings,
      });

      expect(facts.projectRoot).toBe(join(f.root, "go/service"));
      expect(facts.build.workspace).toBe(join(f.root, "go.work"));
    } finally {
      await f.cleanup();
    }
  }
);

test("bounded cache, explicit refresh, detached result mutation and invalidation", async () => {
  const f = await fixture();

  try {
    const path = await f.put("src/file.ts");
    const discovery = createProjectDiscovery({ registry: f.registry, capacity: 2 });
    const input = { checkout: f.checkout, path, providerId: "typescript", settings: f.settings };
    const first = await discovery.discover(input);
    await f.put("src/tsconfig.json", "{}");
    first.pluginProbeRoots.push("mutated");
    expect((await discovery.discover(input)).projectRoot).toBe(f.root);
    expect((await discovery.discover({ ...input, refresh: true })).projectRoot).toBe(
      join(f.root, "src")
    );

    for (const providerId of ["python", "go", "rust"])
      await discovery.discover({ ...input, providerId });
    expect(discovery.stats().entries).toBe(2);
    expect(discovery.stats().retainedBytes).toBeLessThanOrEqual(discovery.stats().maxRetainedBytes);
    discovery.invalidate();
    expect(discovery.stats().entries).toBe(0);
    expect(discovery.stats().retainedBytes).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("checkout paths and project config symlinks cannot cross canonical roots", async () => {
  const f = await fixture();

  try {
    const path = await f.put("file.ts");
    const discovery = createProjectDiscovery({ registry: f.registry });
    const input = { checkout: f.checkout, path, providerId: "typescript", settings: f.settings };
    await rejects(discovery.discover({ ...input, path: f.review }), /checkout/);
    await symlink(f.review, join(f.root, "escape"));
    await rejects(discovery.discover({ ...input, path: join(f.root, "escape") }), /checkout/);
    await writeFile(join(f.review, "tsconfig.json"), "{}");
    await symlink(join(f.review, "tsconfig.json"), join(f.root, "tsconfig.json"));
    await rejects(discovery.discover(input), /symlink/);
  } finally {
    await f.cleanup();
  }
});

test("config bounds and cyclic extends fail closed without executing configuration", async () => {
  const f = await fixture();

  try {
    const path = await f.put("file.ts");
    const discovery = createProjectDiscovery({ registry: f.registry });
    const input = { checkout: f.checkout, path, providerId: "typescript", settings: f.settings };
    await f.put("tsconfig.json", '{"extends":"./tsconfig.json"}');
    await rejects(discovery.discover(input), /cycle/);
    await f.put("tsconfig.json", " ".repeat(262145));
    await rejects(discovery.discover(input), /bounded/);
  } finally {
    await f.cleanup();
  }
});

test("explicit Host paths override discovered SDK/interpreter/executable; environment stays private", async () => {
  const f = await fixture();

  try {
    const path = await f.put("file.ts");
    await mkdir(join(f.review, "sdk/lib"), { recursive: true });
    await writeFile(join(f.review, "sdk/lib/tsserver.js"), "");
    await writeFile(join(f.review, "runtime"), "");

    const settings = LanguageEffectiveSettings.make({
      ...f.settings,
      settings: {
        sdk: join(f.review, "sdk"),
        interpreter: join(f.review, "runtime"),
        executableOverrides: {
          typescript: {
            executable: join(f.review, "runtime"),
            argv: [],
            environment: { PRIVATE_KEY: "fake-secret" },
          },
        },
      },
    });

    const facts = await createProjectDiscovery({ registry: f.registry }).discover({
      checkout: f.checkout,
      path,
      providerId: "typescript",
      settings,
    });

    expect(facts.sdk).toBe(join(f.review, "sdk"));
    expect(facts.tsserver).toBe(join(f.review, "sdk/lib/tsserver.js"));
    expect(facts.interpreter).toBe(join(f.review, "runtime"));
    expect(facts.environmentKeys).toEqual(["PRIVATE_KEY"]);
    expect(facts.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await f.cleanup();
  }
});

test("in-flight invalidation cannot repopulate cache and concurrent demand is bounded", async () => {
  const f = await fixture();

  try {
    const path = await f.put("file.ts");
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const discovery = createProjectDiscovery({
      maxPending: 1,
      registry: async (checkout) => {
        await gate;

        return f.registry(checkout);
      },
    });

    const input = { checkout: f.checkout, path, providerId: "typescript", settings: f.settings };
    const pending = discovery.discover(input);
    await rejects(discovery.discover(input), /concurrency/);
    discovery.invalidate();
    release();
    await pending;
    expect(discovery.stats().entries).toBe(0);
    expect(discovery.stats().pending).toBe(0);
    await discovery.discover(input);
    expect(discovery.stats().entries).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("untrusted discovery identifies executable configs without importing them", async () => {
  const f = await fixture();

  try {
    const sentinel = join(f.temporary, "executed");
    const malicious = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); throw new Error("Executed project code");`;
    const config = await f.put("prisma.config.ts", malicious);
    const formatter = await f.put("prettier.config.js", malicious);
    const schema = await f.put("prisma/schema.prisma");

    const result = await createProjectDiscovery({ registry: f.registry }).discover({
      checkout: f.checkout,
      path: schema,
      providerId: "prisma",
      settings: f.settings,
    });

    expect(result.prisma?.config).toBe(config);
    expect(result.prisma?.configurationDeferred).toBe(true);
    expect(result.formatterConfiguration).toBe(formatter);
    expect(await Bun.file(sentinel).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

posixVenv("ordinary virtual environment runtime symlinks preserve environment path", async () => {
  const f = await fixture();

  try {
    const runtime = join(f.review, "fake-python");
    await writeFile(runtime, "");
    await f.put("pyproject.toml");
    await mkdir(join(f.root, ".venv/bin"), { recursive: true });
    await symlink(runtime, join(f.root, ".venv/bin/python"));
    const path = await f.put("main.py");

    const result = await createProjectDiscovery({ registry: f.registry }).discover({
      checkout: f.checkout,
      path,
      providerId: "pyright",
      settings: f.settings,
    });

    expect(result.interpreter).toBe(join(f.root, ".venv/bin/python"));
    expect(result.interpreterTarget).toBe(runtime);
  } finally {
    await f.cleanup();
  }
});

test("actual Worktree and Review Checkout roots have independent discovery facts", async () => {
  const f = await fixture();

  try {
    await writeFile(join(f.worktree, "Cargo.toml"), "[package]");
    await writeFile(join(f.review, "go.mod"), "module review");
    const discovery = createProjectDiscovery({ registry: f.registry });

    const tree = await discovery.discover({
      checkout: f.treeCheckout,
      path: f.worktree,
      providerId: "rust-analyzer",
      settings: f.settings,
    });

    const review = await discovery.discover({
      checkout: f.reviewCheckout,
      path: f.review,
      providerId: "gopls",
      settings: f.settings,
    });

    expect(tree.projectRoot).toBe(f.worktree);
    expect(review.projectRoot).toBe(f.review);
    expect(tree.configurationFingerprint).not.toBe(review.configurationFingerprint);
    expect(discovery.stats().entries).toBe(2);
  } finally {
    await f.cleanup();
  }
});

test("representative catalog and custom providers use their own root rules", async () => {
  const f = await fixture();

  try {
    const discovery = createProjectDiscovery({ registry: f.registry });

    for (const [providerId, marker, filename] of [
      ["jdtls", "pom.xml", "src/Main.java"],
      ["phpactor", "composer.json", "src/main.php"],
      ["lua-language-server", ".luarc.json", "main.lua"],
      ["yaml-language-server", ".yamllint", "config.yml"],
    ]) {
      await f.put(`${providerId}/${marker}`);
      const path = await f.put(`${providerId}/${filename}`);

      const result = await discovery.discover({
        checkout: f.checkout,
        path,
        providerId: providerId!,
        settings: f.settings,
      });

      expect(result.projectRoot).toBe(join(f.root, providerId!));
    }

    const path = await f.put("custom/main.custom");
    await f.put("custom/own.marker");
    const executable = await f.put("custom/server");

    const settings = LanguageEffectiveSettings.make({
      ...f.settings,
      settings: {
        customServers: [
          {
            id: "custom",
            rootMarkers: ["own.marker"],
            workingDirectory: null,
            launch: { executable, argv: ["--stdio"], environment: {} },
            filePatterns: ["*.custom"],
            documentLanguageId: "custom",
            initializationOptions: { custom: true },
            settings: { setting: true },
          },
        ],
      },
    });

    const result = await discovery.discover({
      checkout: f.checkout,
      path,
      providerId: "custom",
      settings,
    });

    expect(result.projectRoot).toBe(join(f.root, "custom"));
    expect(result.executable).toBe(executable);
    expect(result.effectiveSettings.settings.customServers?.[0]?.initializationOptions).toEqual({
      custom: true,
    });
  } finally {
    await f.cleanup();
  }
});

posixVenv(
  "Python JSON config overrides TOML; inherited venv paths retain their config location",
  async () => {
    const f = await fixture();

    try {
      await f.put("python/pyproject.toml", '[tool.pyright]\nvenvPath="envs"\nvenv="toml"');
      const toml = await f.put("python/envs/toml/bin/python");
      const json = await f.put("python/envs/json/bin/python");
      const path = await f.put("python/src/main.py");
      const discovery = createProjectDiscovery({ registry: f.registry });
      const input = { checkout: f.checkout, path, providerId: "pyright", settings: f.settings };
      expect((await discovery.discover(input)).interpreter).toBe(toml);
      await f.put("python/pyrightconfig.json", '{"venvPath":"envs","venv":"json"}');
      expect((await discovery.discover({ ...input, refresh: true })).interpreter).toBe(json);
      await f.put("python/src/pyrightconfig.json", '{"extends":"../pyrightconfig.json"}');
      expect((await discovery.discover({ ...input, refresh: true })).interpreter).toBe(json);
    } finally {
      await f.cleanup();
    }
  }
);

test("automatic SDK cannot borrow a sibling checkout; explicit SDK skips automatic probe", async () => {
  const f = await fixture();

  try {
    const path = await f.put("file.ts");
    await mkdir(join(f.root, "node_modules"), { recursive: true });
    await mkdir(join(f.review, "sdk/lib"), { recursive: true });
    await writeFile(join(f.review, "sdk/package.json"), '{"name":"typescript","version":"6.0.3"}');
    await writeFile(join(f.review, "sdk/lib/tsserver.js"), "");
    await symlink(join(f.review, "sdk"), join(f.root, "node_modules/typescript"));
    const discovery = createProjectDiscovery({ registry: f.registry });
    const input = { checkout: f.checkout, path, providerId: "typescript", settings: f.settings };
    await rejects(discovery.discover(input), /symlink/);

    const settings = LanguageEffectiveSettings.make({
      ...f.settings,
      settings: { sdk: join(f.review, "sdk") },
    });

    expect((await discovery.discover({ ...input, settings })).tsserver).toBe(
      join(f.review, "sdk/lib/tsserver.js")
    );
  } finally {
    await f.cleanup();
  }
});

test("filesystem probe budget bounds adversarial plugin configurations", async () => {
  const f = await fixture();

  try {
    const path = await f.put("file.ts");
    await f.put(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          plugins: Array.from({ length: 64 }, (_, index) => ({ name: `missing-${index}` })),
        },
      })
    );

    const settings = LanguageEffectiveSettings.make({
      ...f.settings,
      settings: { pluginProbeRoots: Array.from({ length: 64 }, () => f.root) },
    });

    const discovery = createProjectDiscovery({ registry: f.registry });
    await rejects(
      discovery.discover({ checkout: f.checkout, path, providerId: "typescript", settings }),
      /probe limit/
    );
    expect(discovery.stats().entries).toBe(0);
    expect(discovery.stats().pending).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("multiple TS extends preserves earlier plugins unless a later config explicitly replaces them", async () => {
  const f = await fixture();

  try {
    const path = await f.put("file.ts");
    await f.put("base-a.json", '{"compilerOptions":{"plugins":[{"name":"next"}]}}');
    await f.put("base-b.json", '{"compilerOptions":{"strict":true}}');
    await f.put("tsconfig.json", '{"extends":["./base-a.json","./base-b.json"]}');
    const discovery = createProjectDiscovery({ registry: f.registry });
    const input = { checkout: f.checkout, path, providerId: "typescript", settings: f.settings };
    expect((await discovery.discover(input)).plugins.map(({ name }) => name)).toEqual(["next"]);
    await f.put("base-b.json", '{"compilerOptions":{"plugins":[]}}');
    expect((await discovery.discover({ ...input, refresh: true })).plugins).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("refresh detects config content changes even when effective paths and plugin names are unchanged", async () => {
  const f = await fixture();

  try {
    const path = await f.put("file.ts");
    const config = await f.put("tsconfig.json", '{"compilerOptions":{"strict":false}}');
    const discovery = createProjectDiscovery({ registry: f.registry });
    const input = { checkout: f.checkout, path, providerId: "typescript", settings: f.settings };
    const before = await discovery.discover(input);
    await f.put("tsconfig.json", '{"compilerOptions":{"strict":true}}');
    expect((await discovery.discover(input)).configurationFingerprint).toBe(
      before.configurationFingerprint
    );
    const after = await discovery.discover({ ...input, refresh: true });
    expect(after.configurationInputs[config]).not.toBe(before.configurationInputs[config]);
    expect(after.configurationFingerprint).not.toBe(before.configurationFingerprint);
  } finally {
    await f.cleanup();
  }
});
