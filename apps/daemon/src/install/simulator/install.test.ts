import { afterAll, beforeAll, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { posixDescribe, posixTest } from "../../platform/testing.ts";
import { tempDir } from "../../platform/tempDir.testing.ts";
import { bunRuntime, installedOnDisk, installSimulatorTools } from "./install.ts";

const describe = posixDescribe("the Simulator never runs on Windows");

const test = posixTest("the Simulator never runs on Windows");

/** An npm tarball: everything under `package/`. */
const tarball = async (name: string, files: Record<string, string>) => {
  const entries = Object.fromEntries(
    Object.entries({ "package.json": JSON.stringify({ name, version: "1.0.0" }), ...files }).map(
      ([path, body]) => [`package/${path}`, body]
    )
  );

  return new Bun.Archive(entries, { compress: "gzip" }).bytes();
};

const integrity = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const ENTRIES = {
  hub: "node_modules/fake-hub/cli.mjs",
  agentDevice: "node_modules/fake-ad/cli.mjs",
};

const MANIFEST = {
  name: "t",
  private: true,
  dependencies: { "fake-ad": "1.0.0", "fake-hub": "1.0.0" },
};

/** A bun.lock for the two fake packages, with the integrity each one is pinned to. */
const lockfile = (pinned: Record<string, Uint8Array>) =>
  JSON.stringify({
    lockfileVersion: 1,
    workspaces: { "": { name: "t", dependencies: MANIFEST.dependencies } },
    packages: Object.fromEntries(
      Object.entries(pinned).map(([name, bytes]) => [
        name,
        [`${name}@1.0.0`, "", {}, integrity(bytes)],
      ])
    ),
  });

const served = new Map<string, Uint8Array>();

let requests = 0;

let registry: ReturnType<typeof Bun.serve> | undefined;

const hub = await tarball("fake-hub", { "cli.mjs": 'console.log("hub ok")' });

const agentDevice = await tarball("fake-ad", { "cli.mjs": 'console.log("agent-device ok")' });

beforeAll(() => {
  registry = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      requests += 1;
      const name = new URL(request.url).pathname.split("/")[1] ?? "";
      const bytes = served.get(name);

      return bytes === undefined ? new Response("not found", { status: 404 }) : new Response(bytes);
    },
  });
});

afterAll(() => registry?.stop(true));

const setup = () => {
  served.set("fake-hub", hub).set("fake-ad", agentDevice);
  requests = 0;
  const root = tempDir("sim-tools-");

  return {
    root,
    options: {
      root,
      version: "9.9.9",
      manifest: MANIFEST,
      lockfile: lockfile({ "fake-hub": hub, "fake-ad": agentDevice }),
      entries: ENTRIES,
      env: { BUN_CONFIG_REGISTRY: `http://127.0.0.1:${registry?.port}/` },
    },
  };
};

const run = (script: string) => {
  const runtime = bunRuntime();

  const proc = Bun.spawnSync([...runtime.argv, script], {
    env: { ...process.env, ...runtime.env },
  });

  return proc.stdout.toString().trim();
};

describe("installSimulatorTools", () => {
  test("installs both tools runnable with the Daemon's Bun, and an upgrade removes the old set", async () => {
    const t = setup();
    mkdirSync(join(t.root, "0.1.0"));

    expect(await installedOnDisk(t.options)).toBeNull();
    const installed = await installSimulatorTools(t.options);

    expect(run(installed.hub)).toBe("hub ok");
    expect(run(installed.agentDevice)).toBe("agent-device ok");
    expect(readdirSync(t.root)).toEqual(["9.9.9"]);
    expect(await installedOnDisk(t.options)).toEqual(installed);
  });

  test("a tarball that doesn't match the lockfile's integrity is never installed", async () => {
    const tampered = await tarball("fake-hub", { "cli.mjs": 'console.log("owned")' });
    const t = setup();
    served.set("fake-hub", tampered);

    await Promise.resolve(
      expect(installSimulatorTools(t.options)).rejects.toThrow("Integrity check failed")
    );
    expect(requests).toBeGreaterThan(0);
    expect(existsSync(join(t.root, "9.9.9"))).toBe(false);
    expect(await installedOnDisk(t.options)).toBeNull();
  });

  test("an install without a tool's entry script is refused and not marked installed", async () => {
    const t = setup();

    await Promise.resolve(
      expect(
        installSimulatorTools({
          ...t.options,
          entries: { ...ENTRIES, hub: "node_modules/fake-hub/missing.mjs" },
        })
      ).rejects.toThrow("the install has no node_modules/fake-hub/missing.mjs")
    );
    expect(await installedOnDisk(t.options)).toBeNull();
  });
});
