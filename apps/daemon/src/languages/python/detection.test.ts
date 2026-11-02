import { pythonSearchPaths } from "./launch.ts";
import { expect, test } from "bun:test";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceId } from "@polaris/protocol";
import { cfgVersion, detectPython, interpreterVersion, nameVersion } from "./detection.ts";
import { createPythonEnvironment, interpreterEntry } from "./environment.ts";
import { createProjectDiscovery } from "../discovery/index.ts";
import { LanguageCheckout, HostId } from "@polaris/protocol";
import { effectiveSettings } from "../discovery/configuration.ts";
import { newTempDir, removeTempDirSettled } from "../../platform/tempDir.testing.ts";

async function fixture() {
  const root = newTempDir("polaris-python-detection-", { short: true });
  const executable = join(root, "host-python");
  await writeFile(executable, "#!/bin/sh\nexit 99\n");
  await chmod(executable, 0o755);
  const host = { home: join(root, "empty-home"), directories: [join(root, "empty-host")] };

  return { root, executable, host, close: () => removeTempDirSettled(root) };
}

test("venv and uv detection preserve the symlink entry and never run it; Host absence is explicit", async () => {
  const f = await fixture();

  try {
    expect(await detectPython(f.root, f.root, "darwin", f.host)).toEqual([]);
    await mkdir(join(f.root, ".venv/bin"), { recursive: true });
    const entry = join(f.root, ".venv/bin/python");
    await symlink(f.executable, entry);
    expect(await detectPython(f.root, f.root, "darwin", f.host)).toEqual([
      { path: entry, source: "venv" },
    ]);
    await writeFile(join(f.root, "uv.lock"), "version = 1\n");
    expect(await detectPython(f.root, f.root, "darwin", f.host)).toEqual([
      { path: entry, source: "uv" },
    ]);
    await rm(join(f.root, "uv.lock"));
    await writeFile(join(f.root, "pyproject.toml"), "[tool.uv]\n");
    expect((await detectPython(f.root, f.root, "darwin", f.host))[0]?.source).toBe("uv");
    await rm(join(f.root, ".venv"), { recursive: true });
    await mkdir(join(f.root, "venv/bin"), { recursive: true });
    await symlink(f.executable, join(f.root, "venv/bin/python"));
    expect((await detectPython(f.root, f.root, "darwin", f.host))[0]?.path).toBe(
      join(f.root, "venv/bin/python")
    );
  } finally {
    await f.close();
  }
});

test("Host fallback reads python3 presence, and ignores PATH/project executables", async () => {
  const f = await fixture();

  try {
    await mkdir(f.host.directories[0]!);
    await symlink(f.executable, join(f.host.directories[0]!, "python3"));
    expect(await detectPython(f.root, f.root, "linux", f.host)).toEqual([
      { path: f.executable, source: "host" },
    ]);
  } finally {
    await f.close();
  }
});

test("per-Workspace selection survives repository recreation; CAS races reject and null returns to detection", async () => {
  const f = await fixture();

  try {
    const id = WorkspaceId.make("workspace");
    const directory = join(f.root, "private");
    const store = createPythonEnvironment(directory);

    const results = await Promise.allSettled([
      store.select(id, f.executable, 0, async () => {}),
      store.select(id, null, 0, async () => {}),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(await createPythonEnvironment(directory).read(id)).toEqual({
      revision: 1,
      interpreter: f.executable,
    });
    const checkout = LanguageCheckout.cases.Workspace.make({ workspaceId: id, path: f.root });

    const discovery = createProjectDiscovery({
      registry: async () => ({ checkout, workspacePath: f.root }),
      bundledTypeScript: true,
      pythonEnvironment: store,
      pythonHost: f.host,
    });

    const input = {
      checkout,
      path: f.root,
      providerId: "basedpyright",
      settings: effectiveSettings(
        { hostId: HostId.make("host"), workspaceId: id, language: "python" },
        [],
        0
      ),
    };

    const first = await discovery.discover(input);
    expect(first.interpreter).toBe(f.executable);
    expect(first.managedPython).toBe(true);
    const lint = await discovery.discover({ ...input, providerId: "ruff" });
    const alternative = join(f.root, "other-python");
    await writeFile(alternative, "#!/bin/sh\nexit 99\n");
    await chmod(alternative, 0o755);
    await store.select(id, alternative, 1, async () => {});
    discovery.invalidate();
    expect(
      (await discovery.discover({ ...input, providerId: "ruff" })).configurationFingerprint
    ).toBe(lint.configurationFingerprint);

    await store.select(id, null, 2, async () => {});
    discovery.invalidate();
    const second = await discovery.discover(input);
    expect(second.interpreter).toBeNull();
    expect(second.configurationFingerprint).not.toBe(first.configurationFingerprint);
    await Promise.resolve(expect(interpreterEntry(join(f.root, "missing"))).rejects.toThrow());
  } finally {
    await f.close();
  }
});

test("venv search paths and target version come from bounded metadata without executing .pth", async () => {
  const f = await fixture();

  try {
    await mkdir(join(f.root, "lib/python3.13/site-packages"), { recursive: true });
    await writeFile(join(f.root, "pyvenv.cfg"), "version = 3.13.7\n");
    await writeFile(
      join(f.root, "lib/python3.13/site-packages/hostile.pth"),
      "import os; raise RuntimeError('must not run')\n"
    );
    expect(await pythonSearchPaths(join(f.root, "bin/python"))).toEqual({
      prefix: f.root,
      paths: [join(f.root, "lib/python3.13/site-packages")],
      version: [3, 13, 7, "final", 0],
    });
    await writeFile(join(f.root, "pyvenv.cfg"), "version = untrusted-code\n");
    expect((await pythonSearchPaths(join(f.root, "bin/python"))).version).toBeNull();
  } finally {
    await f.close();
  }
});

test("versions come from pyvenv.cfg (venv `version`, uv `version_info`) or the name, never by running Python", async () => {
  const f = await fixture();

  try {
    await mkdir(join(f.root, ".venv/bin"), { recursive: true });
    const entry = join(f.root, ".venv/bin/python");
    await symlink(f.executable, entry);
    await writeFile(join(f.root, ".venv/pyvenv.cfg"), "home = /usr/bin\nversion = 3.11.9\n");
    expect(await detectPython(f.root, f.root, "darwin", f.host)).toEqual([
      { path: entry, source: "venv", version: "3.11.9" },
    ]);
    await writeFile(join(f.root, "uv.lock"), "version = 1\n");
    await writeFile(
      join(f.root, ".venv/pyvenv.cfg"),
      "home = /opt/python/bin\nimplementation = CPython\nuv = 0.9.0\nversion_info = 3.12.4\n"
    );
    expect(await detectPython(f.root, f.root, "darwin", f.host)).toEqual([
      { path: entry, source: "uv", version: "3.12.4" },
    ]);

    const named = join(f.root, "host-bin/python3.13");
    await mkdir(join(f.root, "host-bin"));
    await symlink(f.executable, named);
    await symlink(named, join(f.root, "host-bin/python3"));
    expect(await nameVersion(join(f.root, "host-bin/python3"))).toBe("3.13");
    expect(await nameVersion(f.executable)).toBeNull();
    expect(await interpreterVersion(entry)).toBe("3.12.4");
    expect(await interpreterVersion(named)).toBe("3.13");
    expect(cfgVersion("version = 3.10\n")).toBe("3.10");
    expect(cfgVersion("version = garbage\n")).toBeNull();
  } finally {
    await f.close();
  }
});
