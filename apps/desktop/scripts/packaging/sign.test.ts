import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackArchive } from "@polaris/client/install";
import { REPO_ROOT } from "../lib/build.ts";
import { daemonChecksumsName, RELEASE_DIR, stageDaemon, writeDaemonArchives } from "./archives.ts";
import { DARWIN_PATHS, daemonDist, hash, removeDists } from "./dist.testing.ts";
import { fileFacts, readManifest, verifyDaemonManifest } from "./manifest.ts";

const roots: string[] = [];

const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "polaris-sign-"));
  roots.push(root);

  return root;
};

afterEach(() => {
  removeDists();

  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SIGNER = join(REPO_ROOT, "tooling/release/sign.py");

const ENTITLEMENTS = join(import.meta.dir, "entitlements");

const VERSION = "0.1.0-rc.1";

// Any Mach-O file signs; a copy of a system tool is the smallest at hand.
const MACHO = "/usr/bin/true";

const plist = (keys: Record<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${Object.entries(keys)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("")}</dict></plist>\n`;

/** The macOS Daemon's app bundle and its executables, under a dist. */
const DAEMON_APP = "darwin-arm64/PolarisDaemon.app";

const daemonFile = (name: keyof typeof DARWIN_PATHS) => `darwin-arm64/${DARWIN_PATHS[name]}`;

/** A release dist whose darwin-arm64 bundle holds real Mach-O files, archived like a release. */
const releaseDist = () => {
  const dist = daemonDist(VERSION);
  const path = join(dist, "manifest.json");
  const manifest = readManifest(dist);
  const build = manifest.platforms["darwin-arm64"]!;
  const files = { ...build.files };

  copyFileSync(MACHO, join(dist, daemonFile("polaris")));
  copyFileSync(MACHO, join(dist, daemonFile("betterleaks")));
  writeFileSync(
    join(dist, daemonFile("Info.plist")),
    plist({ CFBundleExecutable: "polaris", CFBundleIdentifier: "dev.lux.polaris.daemon" })
  );

  for (const name of Object.keys(files))
    files[name] = { ...files[name]!, ...fileFacts(join(dist, "darwin-arm64", files[name]!.path!)) };

  const platforms = {
    ...manifest.platforms,
    "darwin-arm64": { ...build, files, sha256: files.polaris!.sha256 },
  };

  writeFileSync(path, JSON.stringify({ ...manifest, platforms }));
  writeDaemonArchives(dist);

  return dist;
};

const bundle = (path: string, executable: string) => {
  mkdirSync(join(path, "Contents/MacOS"), { recursive: true });
  writeFileSync(
    join(path, "Contents/Info.plist"),
    plist({
      CFBundleExecutable: executable,
      CFBundleIdentifier: `test.${executable.replaceAll(" ", "")}`,
    })
  );
  copyFileSync(MACHO, join(path, "Contents/MacOS", executable));
};

/** The shape of an Electron app: a helper app and a versioned framework with a library. */
const releaseApp = (dist: string) => {
  const app = join(scratch(), "Polaris.app");
  bundle(app, "Polaris");
  bundle(join(app, "Contents/Frameworks/Polaris Helper.app"), "Polaris Helper");
  const framework = join(app, "Contents/Frameworks/Fake.framework");
  mkdirSync(join(framework, "Versions/A/Resources"), { recursive: true });
  mkdirSync(join(framework, "Versions/A/Libraries"));
  copyFileSync(MACHO, join(framework, "Versions/A/Fake"));
  copyFileSync(MACHO, join(framework, "Versions/A/Libraries/libfake.dylib"));
  writeFileSync(
    join(framework, "Versions/A/Resources/Info.plist"),
    plist({
      CFBundleExecutable: "Fake",
      CFBundleIdentifier: "test.fake",
      CFBundlePackageType: "FMWK",
    })
  );
  symlinkSync("A", join(framework, "Versions/Current"));
  symlinkSync("Versions/Current/Fake", join(framework, "Fake"));
  symlinkSync("Versions/Current/Resources", join(framework, "Resources"));
  mkdirSync(join(app, "Contents/Resources"));
  writeFileSync(join(app, "Contents/Resources/app.asar"), "asar");
  stageDaemon(dist, join(app, "Contents/Resources/daemon"), ["darwin-arm64"]);

  return app;
};

const signer = (...args: string[]) => {
  const result = Bun.spawnSync(["python3", "-I", SIGNER, "--ad-hoc", ...args], {
    env: { PATH: process.env.PATH ?? "" },
  });

  return { ok: result.exitCode === 0, error: result.stderr.toString() };
};

const DIST = "apps/daemon/dist";

const APP = "apps/desktop/out/dist/Polaris-darwin-arm64/Polaris.app";

/** The build job's hand-off: the Daemon dist and the app in one tar, as release.yml packs it. */
const handoff = (dist: string, app: string) => {
  const root = scratch();
  cpSync(dist, join(root, DIST), { recursive: true, verbatimSymlinks: true });
  cpSync(app, join(root, APP), { recursive: true, verbatimSymlinks: true });
  const tar = join(root, "release-bundle.tar");
  Bun.spawnSync(["tar", "--no-mac-metadata", "-cf", tar, "-C", root, DIST, APP], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });

  return { tar, sha256: hash(readFileSync(tar)), out: join(root, "signed") };
};

const signApp = (bundle: ReturnType<typeof handoff>) =>
  signer(
    "app",
    "--handoff",
    bundle.tar,
    "--sha256",
    bundle.sha256,
    "--out",
    bundle.out,
    "--entitlements",
    ENTITLEMENTS,
    "--version",
    VERSION
  );

/** Where the signer left the signed Daemon dist and app. */
const signed = (bundle: ReturnType<typeof handoff>) => ({
  dist: join(bundle.out, "tree", DIST),
  app: join(bundle.out, "tree", APP),
  assets: join(bundle.out, "handoff/assets"),
});

/** `codesign --display` facts: the flags line and the entitlements XML. */
const signature = (path: string) => {
  const result = Bun.spawnSync([
    "codesign",
    "--display",
    "--verbose=2",
    "--entitlements",
    "-",
    "--xml",
    path,
  ]);

  return `${result.stderr.toString()}${result.stdout.toString()}`;
};

const spawnChecked = (cmd: string[]) => {
  const result = Bun.spawnSync(cmd);

  if (result.exitCode !== 0) throw new Error(`${cmd[1]} failed: ${result.stderr.toString()}`);
};

/**
 * A compressed (UDZO) image like the release's, made without mounting a volume: attaching one
 * on a shared macOS runner took most of a minute, and the signer never looks inside the image.
 */
const compressedImage = (root: string, dmg: string) => {
  const content = join(root, "content");
  mkdirSync(content);
  writeFileSync(join(content, "README"), "installer image\n");
  const hybrid = join(root, "hybrid.dmg");
  spawnChecked(["hdiutil", "makehybrid", "-quiet", "-hfs", "-o", hybrid, content]);
  spawnChecked(["hdiutil", "convert", "-quiet", hybrid, "-format", "UDZO", "-o", dmg]);
};

const verifies = (...args: string[]) =>
  Bun.spawnSync(["codesign", "--verify", "--strict", ...args]).exitCode === 0;

describe.skipIf(process.platform !== "darwin")("the release signer", () => {
  test("re-records the signed Daemon in the manifests, its archive and checksums", () => {
    const source = releaseDist();
    const bundle = handoff(source, releaseApp(source));
    const unsigned = readFileSync(join(source, daemonFile("polaris")));

    expect(signApp(bundle)).toEqual({ ok: true, error: "" });

    const { dist, app } = signed(bundle);
    const polaris = readFileSync(join(dist, daemonFile("polaris")));
    expect(polaris.equals(unsigned)).toBe(false);
    // Signed as one app bundle, so System Settings names it from its Info.plist (ENG-680).
    expect(signature(join(dist, DAEMON_APP))).toContain("Identifier=dev.lux.polaris.daemon");
    expect(signature(join(dist, DAEMON_APP))).toContain("(adhoc,runtime)");
    expect(verifies("--deep", join(dist, DAEMON_APP))).toBe(true);
    verifyDaemonManifest(dist, VERSION);

    const manifest = readManifest(dist);
    const archive = manifest.platforms["darwin-arm64"]!.archive!;
    const archived = unpackArchive(readFileSync(join(dist, RELEASE_DIR, archive.name)));
    expect(archived.map((entry) => [entry.name, entry.mode])).toEqual([
      ["polaris", 0o755],
      ["betterleaks", 0o755],
      ["Info.plist", 0o644],
      ["Polaris.icns", 0o644],
      ["CodeResources", 0o644],
    ]);
    expect(Buffer.from(archived[0]!.bytes).equals(polaris)).toBe(true);
    const sealed = readFileSync(join(dist, daemonFile("CodeResources")));
    expect(Buffer.from(archived[4]!.bytes).equals(sealed)).toBe(true);
    expect(fileFacts(join(dist, RELEASE_DIR, archive.name))).toEqual({
      sha256: archive.sha256,
      size: archive.size,
    });
    expect(readFileSync(join(dist, RELEASE_DIR, daemonChecksumsName(VERSION)), "utf8")).toContain(
      `${archive.sha256}  ${archive.name}\n`
    );

    const staged = join(app, "Contents/Resources/daemon");
    verifyDaemonManifest(staged, VERSION);
    expect(readManifest(staged)).toEqual({ ...manifest, bundled: ["darwin-arm64"] });
    expect(verifies("--deep", join(staged, DAEMON_APP))).toBe(true);
  });

  test("signs the app from the inside out, keeping the Daemon's own entitlements", () => {
    const source = releaseDist();
    const bundle = handoff(source, releaseApp(source));

    expect(signApp(bundle).ok).toBe(true);

    const { app, assets } = signed(bundle);
    expect(verifies("--deep", app)).toBe(true);

    for (const nested of [
      "Contents/Frameworks/Polaris Helper.app",
      "Contents/Frameworks/Fake.framework/Versions/A/Libraries/libfake.dylib",
    ])
      expect(signature(join(app, nested))).toContain("(adhoc,runtime)");
    expect(signature(join(app, "Contents/Resources/daemon", DAEMON_APP))).toContain(
      "com.apple.security.cs.disable-library-validation"
    );

    const listing = Bun.spawnSync([
      "unzip",
      "-l",
      join(assets, `Polaris-${VERSION}-arm64-mac.zip`),
    ]);

    expect(listing.stdout.toString()).toContain("Polaris.app/Contents/MacOS/Polaris");
  });

  test("hands off the signed outputs with the digests the next jobs check", () => {
    const source = releaseDist();
    const bundle = handoff(source, releaseApp(source));

    expect(signApp(bundle).ok).toBe(true);

    const { assets } = signed(bundle);
    const digests = readFileSync(join(bundle.out, "digests"), "utf8").trim().split("\n");

    expect(digests).toEqual([
      `bundle=${hash(readFileSync(join(bundle.out, "handoff/release-bundle-signed.tar")))}`,
      `daemon=${hash(readFileSync(join(bundle.out, "handoff/polaris-daemon-dist.tar.gz")))}`,
      `assets=${hash(readFileSync(join(assets, "assets.sha256")))}`,
    ]);

    const listed = readFileSync(join(assets, "assets.sha256"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [sha256, name] = line.split("  ");

        return [name, sha256 === hash(readFileSync(join(assets, name!)))];
      });

    expect(listed).toEqual(
      readdirSync(assets)
        .filter((name) => name !== "assets.sha256")
        .toSorted()
        .map((name) => [name, true])
    );

    expect(listed.map(([name]) => name)).toContain(`Polaris-${VERSION}-arm64-mac.zip`);
  });

  test("refuses a Daemon whose bytes differ from its manifest", () => {
    const source = releaseDist();
    const app = releaseApp(source);
    writeFileSync(join(source, daemonFile("betterleaks")), "replaced");

    const { ok, error } = signApp(handoff(source, app));

    expect(ok).toBe(false);
    expect(error).toContain("darwin-arm64/betterleaks: bytes differ from the Daemon manifest");
  });

  test("refuses a hand-off whose Daemon is a symlink out of it, signing nothing", () => {
    const source = releaseDist();
    const app = releaseApp(source);
    const outside = join(scratch(), "outside");
    copyFileSync(MACHO, outside);
    rmSync(join(source, daemonFile("polaris")));
    symlinkSync(outside, join(source, daemonFile("polaris")));

    const { ok, error } = signApp(handoff(source, app));

    expect(ok).toBe(false);
    expect(error).toContain("points outside the app's Frameworks");
    expect(readFileSync(outside).equals(readFileSync(MACHO))).toBe(true);
  });

  test("signs a copy of the installer image", () => {
    const root = scratch();
    const dmg = join(root, `Polaris-${VERSION}-arm64.dmg`);
    compressedImage(root, dmg);
    const out = join(root, "signed");

    expect(signer("dmg", "--dmg", dmg, "--sha256", hash(readFileSync(dmg)), "--out", out).ok).toBe(
      true
    );
    expect(verifies(dmg)).toBe(false);
    expect(verifies(join(out, "assets", `Polaris-${VERSION}-arm64.dmg`))).toBe(true);
  }, 60_000);
});
