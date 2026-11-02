/**
 * The published tarball, as an Extension author gets it: `npm pack` output
 * with no workspace dependencies, installed beside `effect` only, imported
 * by plain Node against the real Daemon, and typechecked as a consumer.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { launchDaemon, type TestDaemon } from "./daemon.testing.ts";

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  repository: Schema.Struct({ url: Schema.String, directory: Schema.String }),
  dependencies: Schema.Record(Schema.String, Schema.String),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const SDK = resolve(import.meta.dir, "..");

const REPO = resolve(SDK, "..", "..");

let project: string;

let out: string;

let daemon: TestDaemon;

const run = (argv: ReadonlyArray<string>, cwd: string, env: Record<string, string> = {}) => {
  const result = Bun.spawnSync([...argv], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

beforeAll(async () => {
  out = mkdtempSync(join(SDK, ".pack-test-"));
  const packed = run(["bun", "scripts/build.ts", "--pack", "--out", out], SDK);

  if (packed.exitCode !== 0) throw new Error(packed.output);
  const tarball = packed.output.trim().split("\n").at(-1) ?? "";

  project = mkdtempSync("/tmp/pl-sdk-consumer-");
  const installed = join(project, "node_modules", "@doellsoftware", "polaris-sdk");

  mkdirSync(installed, { recursive: true });
  run(["tar", "xzf", tarball, "-C", installed, "--strip-components=1"], project);
  // `effect` is the only dependency; link the repo's copy instead of downloading it.
  const effect = dirname(require.resolve("effect/package.json", { paths: [SDK] }));

  symlinkSync(effect, join(project, "node_modules", "effect"));
  writeFileSync(join(project, "package.json"), '{ "type": "module", "private": true }\n');
  daemon = await launchDaemon();
}, 180_000);

afterAll(async () => {
  await daemon.stop();
  rmSync(project, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("the manifest depends on effect alone, and on no workspace package", () => {
  const text = readFileSync(
    join(project, "node_modules", "@doellsoftware", "polaris-sdk", "package.json"),
    "utf8"
  );

  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(text);

  expect(Object.keys(manifest.dependencies)).toEqual(["effect"]);
  expect(manifest.devDependencies).toBeUndefined();
  expect(text).not.toContain("workspace:");
});

test("the manifest carries the published name and the repository npm provenance checks", () => {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    readFileSync(
      join(project, "node_modules", "@doellsoftware", "polaris-sdk", "package.json"),
      "utf8"
    )
  );

  expect(manifest.name).toBe("@doellsoftware/polaris-sdk");
  expect(manifest.version).toBe("0.2.0");
  expect(manifest.repository).toEqual({
    url: "git+https://github.com/luxdotdev/polaris.git",
    directory: "packages/sdk",
  });
});

test("plain Node imports the package and reads a Host over the local socket", async () => {
  await daemon.registerWorkspace();
  const pairing = await daemon.pair("Node", ["read"]);

  writeFileSync(
    join(project, "read.mjs"),
    `import { createPolaris } from "@doellsoftware/polaris-sdk";
const polaris = await createPolaris({ pairings: [process.env.PAIRING], clientName: "node" });
for await (const view of polaris.subscribeHost(polaris.hosts[0].hostId)) {
  console.log(JSON.stringify({ connected: view.connected, workspaces: view.workspaces.length }));
  break;
}
await polaris.close();
`
  );

  const result = run(["node", "read.mjs"], project, {
    PAIRING: pairing,
    POLARIS_HOME: daemon.home,
  });

  expect(result.output.trim()).toBe('{"connected":true,"workspaces":1}');
  expect(result.exitCode).toBe(0);
}, 60_000);

test("the browser build reads a Host over the gateway and refuses the local socket", async () => {
  const gateway = await daemon.pair("Browser", ["read"], "gateway");
  const local = await daemon.pair("Browser local", ["read"]);

  // The browser build in a runtime with a global WebSocket and no Node modules in its path.
  writeFileSync(
    join(project, "browser.mjs"),
    `import { createPolaris } from "./node_modules/@doellsoftware/polaris-sdk/browser.js";
const polaris = await createPolaris({ pairings: [process.env.GATEWAY], clientName: "browser" });
for await (const view of polaris.subscribeHost(polaris.hosts[0].hostId)) {
  console.log(JSON.stringify({ connected: view.connected }));
  break;
}
await polaris.close();
const local = await createPolaris({ pairings: [process.env.LOCAL], clientName: "browser" });
await local.connect(local.hosts[0].hostId).catch((error) => console.log(error._tag));
await local.close();
`
  );
  const result = run(["bun", "browser.mjs"], project, { GATEWAY: gateway, LOCAL: local });

  expect(result.output.trim().split("\n")).toEqual(['{"connected":true}', "HostUnreachable"]);
}, 60_000);

test.each(["NodeNext", "Bundler"] as const)(
  "a %s consumer typechecks with the domain types intact",
  (resolution) => {
    writeFileSync(
      join(project, "consumer.ts"),
      `import { createPolaris, NotGranted, type HostView, type SessionView } from "@doellsoftware/polaris-sdk";

type IsAny<T> = 0 extends 1 & T ? true : false;
const stateIsTyped: IsAny<HostView["sessions"][number]["session"]["state"]> = false;
const itemsAreTyped: IsAny<SessionView["turns"][number]["items"][number]> = false;
// Raycast checks this field before offering a remembered approval.
export const offersAlwaysAllow = (approval: HostView["approvals"][number]) =>
  approval.profileAttach === undefined;

export const main = async (pairing: string) => {
  const polaris = await createPolaris({ pairings: [pairing], clientName: "consumer" });
  try {
    await polaris.sendTurn(polaris.hosts[0]!.hostId, "s", "hi");
  } catch (error) {
    if (error instanceof NotGranted) {
      const needed: "read" | "approve" | "turn" | "start" | "voice" | null = error.needed;
      return needed;
    }
  }
  return [stateIsTyped, itemsAreTyped];
};
`
    );
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: resolution === "Bundler" ? "Preserve" : "NodeNext",
          moduleResolution: resolution,
          customConditions: resolution === "Bundler" ? ["browser"] : [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
          lib: ["ES2022", "DOM", "ESNext.Disposable"],
        },
        files: ["consumer.ts"],
      })
    );

    const result = run(
      ["bun", join(REPO, "node_modules", "typescript", "bin", "tsc"), "-p", "."],
      project
    );

    expect(result.output).toBe("");
    expect(result.exitCode).toBe(0);
  },
  60_000
);
