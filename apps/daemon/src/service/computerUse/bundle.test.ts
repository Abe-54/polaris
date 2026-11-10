import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { BUNDLE_FILE_NAMES, BUNDLE_FILES, DAEMON_BUNDLE, infoPlist } from "../bundle.ts";
import { type InstallContext, layout, stageBinary } from "../install.ts";
import { buildHelper } from "./build.ts";
import {
  COMPUTER_USE_BUNDLE,
  HELPER_FILE_NAMES,
  HELPER_FILES,
  type HelperFile,
  helperBeside,
  helperInfoPlist,
} from "./bundle.ts";

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
  root = newTempDir("polaris-cu-bundle-");
});

afterEach(() => removeTempDir(root));

const bundleId = (plist: string) =>
  /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];

test("dev and release builds have different bundle ids, so they never share a TCC row", () => {
  expect(bundleId(helperInfoPlist("0.9.0", true))).toBe("dev.lux.polaris.computer-use");
  expect(bundleId(helperInfoPlist("0.9.0-dev.12.abc1234", false))).toBe(
    "dev.lux.polaris.computer-use.dev"
  );
});

test("a dev helper's Info.plist is the same from one dev build to the next", () => {
  // An ad hoc grant is keyed to the cdhash, which seals this file.
  expect(helperInfoPlist("0.9.0-dev.13.def5678.dirty1794286364", false)).toBe(
    helperInfoPlist("0.9.0-dev.12.abc1234", false)
  );
});

/** A build's Daemon and helper files laid flat in `dir`, as an upload has them. */
const flatBuild = (dir: string, version: string, helper: boolean) => {
  mkdirSync(dir, { recursive: true });

  for (const name of BUNDLE_FILE_NAMES) writeFileSync(join(dir, name), `daemon ${name}`);
  writeFileSync(join(dir, "Info.plist"), infoPlist(version));

  if (helper)
    for (const name of HELPER_FILE_NAMES) writeFileSync(join(dir, name), `helper ${name}`);
};

const stage = (source: string, version: string) =>
  Effect.runPromise(stageBinary(ctx(), { source, version }));

test("an upload's helper files go to the helper app beside the Daemon's bundle", async () => {
  const upload = join(root, "upload");
  flatBuild(upload, "1.2.3", true);

  expect((await stage(join(upload, "polaris"), "1.2.3")).changed).toBe(true);

  const versionDir = layout(ctx(), "1.2.3").versionDir!;
  const helper = join(versionDir, COMPUTER_USE_BUNDLE);
  const at = (name: HelperFile) => join(helper, HELPER_FILES[name]);

  for (const name of HELPER_FILE_NAMES)
    expect(readFileSync(at(name), "utf8")).toBe(`helper ${name}`);

  for (const name of [
    "polaris-computer-use",
    "agent-desktop",
    "agent-desktop-macos-helper",
  ] as const)
    expect(statSync(at(name)).mode & 0o777).toBe(0o755);
  expect(statSync(at("computer-use-Info.plist")).mode & 0o777).toBe(0o644);
  // The running Daemon finds it from its own executable, through the `polaris` link too.
  expect(helperBeside(join(versionDir, DAEMON_BUNDLE, BUNDLE_FILES.polaris))).toBe(helper);
  expect((await stage(join(upload, "polaris"), "1.2.3")).changed).toBe(false);
});

test("a build from before the helper installs without one", async () => {
  const upload = join(root, "upload");
  flatBuild(upload, "1.2.3", false);
  await stage(join(upload, "polaris"), "1.2.3");

  const versionDir = layout(ctx(), "1.2.3").versionDir!;
  expect(helperBeside(join(versionDir, DAEMON_BUNDLE, BUNDLE_FILES.polaris))).toBeNull();
});

macOnly("a built helper verifies after the flat trip, under the build's bundle id", async () => {
  const dist = join(root, "dist");
  const daemon = join(dist, DAEMON_BUNDLE);

  for (const name of ["polaris", "betterleaks"] as const) {
    mkdirSync(dirname(join(daemon, BUNDLE_FILES[name])), { recursive: true });
    copyFileSync("/usr/bin/true", join(daemon, BUNDLE_FILES[name]));
  }

  writeFileSync(join(daemon, BUNDLE_FILES["Info.plist"]), infoPlist("1.2.3"));
  mkdirSync(dirname(join(daemon, BUNDLE_FILES["Polaris.icns"])), { recursive: true });
  writeFileSync(join(daemon, BUNDLE_FILES["Polaris.icns"]), "icns");
  expect(Bun.spawnSync(["codesign", "--force", "--sign", "-", daemon]).exitCode).toBe(0);
  const icon = join(root, "icon.icns");
  writeFileSync(icon, "icns");

  const built = await buildHelper({
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
    copyFileSync(join(built, HELPER_FILES[name]), join(upload, name));
  await stage(join(upload, "polaris"), "1.2.3-dev.1.abc1234");

  const installed = join(layout(ctx(), "1.2.3-dev.1.abc1234").versionDir!, COMPUTER_USE_BUNDLE);
  const verify = Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", installed]);
  expect(verify.stderr.toString()).toBe("");
  expect(verify.exitCode).toBe(0);
  const shown = Bun.spawnSync(["codesign", "--display", "--verbose=1", installed]);
  expect(shown.stderr.toString()).toContain("Identifier=dev.lux.polaris.computer-use.dev\n");
});
