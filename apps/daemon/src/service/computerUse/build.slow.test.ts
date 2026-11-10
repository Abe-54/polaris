/**
 * The helper built for real (clang, swiftc, codesign) and staged from a flat upload. Slow
 * tier: the Swift compile alone takes seconds. macOS only.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import {
  BUNDLE_FILE_NAMES,
  BUNDLE_FILES,
  BUNDLE_LIBRARY_NAMES,
  DAEMON_BUNDLE,
  infoPlist,
} from "../bundle.ts";
import { type InstallContext, layout, stageBinary } from "../install.ts";
import { buildHelper, compileCapture } from "./build.ts";
import { COMPUTER_USE_BUNDLE, HELPER_FILE_NAMES, HELPER_FILES } from "./bundle.ts";

const macOnly = process.platform === "darwin" ? test : test.skip;

let root: string;

const ctx = (): InstallContext => ({
  os: "darwin",
  polarisHome: join(root, ".polaris"),
  userHome: root,
  xdgConfigHome: null,
  uid: 501,
  user: "ada",
  path: "/usr/bin:/bin",
  launchdLabel: "computer-use-test",
});

beforeEach(() => {
  root = newTempDir("polaris-cu-build-");
});

afterEach(() => removeTempDir(root));

const stage = (source: string, version: string) =>
  Effect.runPromise(stageBinary(ctx(), { source, version }));

const BUILD_TIMEOUT_MS = 120_000;

const built = (name: string, run: () => Promise<void>) => macOnly(name, run, BUILD_TIMEOUT_MS);

built("a built helper verifies after the flat trip, under the build's bundle id", async () => {
  const dist = join(root, "dist");
  const daemon = join(dist, DAEMON_BUNDLE);

  for (const name of ["polaris", "betterleaks", ...BUNDLE_LIBRARY_NAMES] as const) {
    mkdirSync(dirname(join(daemon, BUNDLE_FILES[name])), { recursive: true });
    copyFileSync("/usr/bin/true", join(daemon, BUNDLE_FILES[name]));
  }

  writeFileSync(join(daemon, BUNDLE_FILES["Info.plist"]), infoPlist("1.2.3"));
  mkdirSync(dirname(join(daemon, BUNDLE_FILES["Polaris.icns"])), { recursive: true });
  writeFileSync(join(daemon, BUNDLE_FILES["Polaris.icns"]), "icns");
  expect(Bun.spawnSync(["codesign", "--force", "--sign", "-", daemon]).exitCode).toBe(0);
  const icon = join(root, "icon.icns");
  writeFileSync(icon, "icns");

  const helper = await buildHelper({
    dir: dist,
    version: "1.2.3-dev.1.abc1234",
    release: false,
    inputs: {
      "agent-desktop": "/usr/bin/true",
      "agent-desktop-macos-helper": "/usr/bin/true",
      "computer-use-Polaris.icns": icon,
    },
  });

  const upload = join(root, "upload");
  mkdirSync(upload);

  for (const name of BUNDLE_FILE_NAMES)
    copyFileSync(join(daemon, BUNDLE_FILES[name]), join(upload, name));

  for (const name of HELPER_FILE_NAMES)
    copyFileSync(join(helper, HELPER_FILES[name]), join(upload, name));
  await stage(join(upload, "polaris"), "1.2.3-dev.1.abc1234");

  const installed = join(layout(ctx(), "1.2.3-dev.1.abc1234").versionDir!, COMPUTER_USE_BUNDLE);
  const verify = Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", installed]);
  expect(verify.stderr.toString()).toBe("");
  expect(verify.exitCode).toBe(0);
  const shown = Bun.spawnSync(["codesign", "--display", "--verbose=1", installed]);
  expect(shown.stderr.toString()).toContain("Identifier=dev.lux.polaris.computer-use.dev\n");
});

built("the capture tool is the same binary wherever it is built", async () => {
  // A dev helper's ad hoc grant is keyed to its cdhash, so a rebuild must not change it.
  const first = join(root, "a", "polaris-capture");
  const second = join(root, "b", "polaris-capture");
  mkdirSync(dirname(first));
  mkdirSync(dirname(second));
  await Promise.all([compileCapture(first), compileCapture(second)]);
  expect(Bun.hash(await Bun.file(second).bytes())).toBe(Bun.hash(await Bun.file(first).bytes()));
});
