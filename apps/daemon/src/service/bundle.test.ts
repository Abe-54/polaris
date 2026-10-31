import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import {
  BUNDLE_FILE_NAMES,
  BUNDLE_FILES,
  type BundleFile,
  DAEMON_BUNDLE,
  infoPlist,
} from "./bundle.ts";
import { CommandRunner } from "./CommandRunner.ts";
import { type InstallContext, install, layout, stageBinary } from "./install.ts";
import { posixDescribe } from "../platform/testing.ts";

const macOnly = process.platform === "darwin" ? test : test.skip;

const describeBundle = posixDescribe("symlinks and exec bits (ADR 0060)");

/** launchd with the label loaded nowhere: install's service step is not what these tests are about. */
const launchd = Layer.succeed(
  CommandRunner,
  CommandRunner.of({
    run: (argv) =>
      Effect.succeed({
        code: argv[1] === "print" && argv[2]?.endsWith("/bundle-test") === true ? 113 : 0,
        stdout: "",
        stderr: "",
      }),
  })
);

let root: string;

const ctx = (os: InstallContext["os"]): InstallContext => ({
  os,
  polarisHome: join(root, ".polaris"),
  userHome: root,
  xdgConfigHome: null,
  uid: 501,
  user: "ada",
  path: "/usr/bin:/bin",
  launchdLabel: "bundle-test",
});

/** A build's bundle files laid flat in `dir`, as an upload or a Release archive has them. */
const flatBuild = (dir: string, version: string): Record<BundleFile, string> => {
  mkdirSync(dir, { recursive: true });

  const contents: Record<BundleFile, string> = {
    polaris: `#!/bin/sh\necho polaris ${version} darwin-arm64\n`,
    betterleaks: "#!/bin/sh\necho betterleaks\n",
    "Info.plist": infoPlist(version),
    "Polaris.icns": "icns",
    CodeResources: "sealed resources",
  };

  for (const name of BUNDLE_FILE_NAMES) writeFileSync(join(dir, name), contents[name]);

  return contents;
};

const run = <A, E>(effect: Effect.Effect<A, E, CommandRunner>) =>
  Effect.runPromise(effect.pipe(Effect.provide(launchd)));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-bundle-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describeBundle("a macOS build installs as an app bundle (ENG-680)", () => {
  test("an upload's flat files go back to their places, and polaris links into the bundle", async () => {
    const upload = join(root, "upload");
    const contents = flatBuild(upload, "1.2.3");

    const report = await run(
      install(ctx("darwin"), { source: join(upload, "polaris"), version: "1.2.3" })
    );

    const paths = layout(ctx("darwin"), "1.2.3");
    const bundle = join(paths.versionDir!, DAEMON_BUNDLE);

    for (const name of BUNDLE_FILE_NAMES)
      expect(readFileSync(join(bundle, BUNDLE_FILES[name]), "utf8")).toBe(contents[name]);
    expect(statSync(join(bundle, BUNDLE_FILES.betterleaks)).mode & 0o777).toBe(0o755);
    expect(statSync(join(bundle, BUNDLE_FILES["Info.plist"])).mode & 0o777).toBe(0o644);
    // Every launcher (launchd, Clients' `bin/current/polaris`) reaches the bundle's executable.
    expect(readlinkSync(paths.installed!)).toBe(`${DAEMON_BUNDLE}/Contents/MacOS/polaris`);
    expect(realpathSync(paths.launcher)).toBe(realpathSync(join(bundle, BUNDLE_FILES.polaris)));
    expect(report.binary).toBe(join(bundle, BUNDLE_FILES.polaris));

    const again = await run(
      install(ctx("darwin"), { source: join(upload, "polaris"), version: "1.2.3" })
    );

    expect(again.binaryChanged).toBe(false);
  });

  test("a version first installed flat becomes a bundle, and an older flat one stays", async () => {
    const old = join(root, "old");
    mkdirSync(old);
    writeFileSync(join(old, "polaris"), "#!/bin/sh\necho polaris 1.2.3 darwin-arm64\n");
    await run(stageBinary(ctx("darwin"), { source: join(old, "polaris"), version: "1.2.2" }));
    await run(stageBinary(ctx("darwin"), { source: join(old, "polaris"), version: "1.2.3" }));
    const upload = join(root, "upload");
    flatBuild(upload, "1.2.3");

    const staged = await run(
      stageBinary(ctx("darwin"), { source: join(upload, "polaris"), version: "1.2.3" })
    );

    expect(staged.changed).toBe(true);
    expect(lstatSync(layout(ctx("darwin"), "1.2.3").installed!).isSymbolicLink()).toBe(true);
    // A rollback to the older version still finds a runnable `polaris`.
    expect(lstatSync(layout(ctx("darwin"), "1.2.2").installed!).isFile()).toBe(true);
  });

  test("a Linux Host installs the same files flat, ignoring the bundle's", async () => {
    const upload = join(root, "upload");
    flatBuild(upload, "1.2.3");

    const staged = await run(
      stageBinary(ctx("linux"), { source: join(upload, "polaris"), version: "1.2.3" })
    );

    expect(staged.path).toBe(layout(ctx("linux"), "1.2.3").installed!);
    expect(lstatSync(staged.path).isFile()).toBe(true);
  });

  macOnly("a signed bundle verifies after the flat trip and names itself Polaris", async () => {
    const built = join(root, "dist", DAEMON_BUNDLE);
    const at = (name: BundleFile) => join(built, BUNDLE_FILES[name]);

    for (const name of ["polaris", "betterleaks"] as const) {
      mkdirSync(dirname(at(name)), { recursive: true });
      copyFileSync("/usr/bin/true", at(name));
    }

    writeFileSync(at("Info.plist"), infoPlist("1.2.3"));
    mkdirSync(dirname(at("Polaris.icns")), { recursive: true });
    writeFileSync(at("Polaris.icns"), "icns");
    expect(Bun.spawnSync(["codesign", "--force", "--sign", "-", built]).exitCode).toBe(0);
    const upload = join(root, "upload");
    mkdirSync(upload);

    for (const name of BUNDLE_FILE_NAMES) copyFileSync(at(name), join(upload, name));

    const staged = await run(
      stageBinary(ctx("darwin"), { source: join(upload, "polaris"), version: "1.2.3" })
    );

    const installed = join(layout(ctx("darwin"), "1.2.3").versionDir!, DAEMON_BUNDLE);
    const verify = Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", installed]);
    expect(verify.stderr.toString()).toBe("");
    expect(verify.exitCode).toBe(0);
    const shown = Bun.spawnSync(["codesign", "--display", "--verbose=1", staged.path]);
    expect(shown.stderr.toString()).toContain("Identifier=dev.lux.polaris.daemon");
  });
});
