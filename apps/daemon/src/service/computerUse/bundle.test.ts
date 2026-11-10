import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";
import { BUNDLE_FILE_NAMES, BUNDLE_FILES, DAEMON_BUNDLE, infoPlist } from "../bundle.ts";
import { type InstallContext, layout, stageBinary } from "../install.ts";
import {
  COMPUTER_USE_BUNDLE,
  HELPER_FILE_NAMES,
  HELPER_FILES,
  type HelperFile,
  helperBeside,
  helperInfoPlist,
} from "./bundle.ts";

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
    "polaris-capture",
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
