import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBuilds, PLATFORMS, unpackArchive } from "@polaris/client/install";
import {
  bundledPlatforms,
  daemonChecksumsName,
  RELEASE_DIR,
  stageDaemon,
  verifyDaemonArchives,
  verifyDownloadable,
  writeDaemonArchives,
} from "./archives.ts";
import { daemonDist, hash, removeDists } from "./dist.testing.ts";
import { verifyDaemonManifest } from "./manifest.ts";

afterEach(removeDists);

const VERSION = "0.1.0-alpha.3";

const stage = (dist: string, bundled: Parameters<typeof stageDaemon>[2]) => {
  const dest = join(dist, "staged", "daemon");
  stageDaemon(dist, dest, bundled);

  return dest;
};

describe("release Daemon archives", () => {
  test("one archive per platform with the manifest's files, a checksums file, and the download URL", () => {
    const dist = daemonDist(VERSION);
    const assets = writeDaemonArchives(dist);

    expect(assets.map((path) => path.split("/").at(-1))).toEqual([
      ...PLATFORMS.map((platform) => `polaris-daemon-${VERSION}-${platform}.tar.gz`),
      daemonChecksumsName(VERSION),
    ]);
    const sums = readFileSync(join(dist, RELEASE_DIR, daemonChecksumsName(VERSION)), "utf8");
    expect(sums.trim().split("\n")).toHaveLength(PLATFORMS.length);

    for (const build of loadBuilds(dist)) {
      expect(build.archive?.url).toBe(
        `https://polaris.lux.dev/api/daemon/${VERSION}/${build.platform}`
      );
      const bytes = readFileSync(join(dist, RELEASE_DIR, build.archive!.name));
      expect(hash(bytes)).toBe(build.archive!.sha256);
      expect(sums).toContain(`${build.archive!.sha256}  ${build.archive!.name}`);
      const entries = unpackArchive(bytes);
      // macOS's app bundle travels flat; `polaris install` puts it back together.
      const bundle = build.platform === "darwin-arm64";

      expect(entries.map((e) => [e.name, e.mode])).toEqual([
        ["polaris", 0o755],
        ["betterleaks", 0o755],
        ...(bundle
          ? [
              ["Info.plist", 0o644],
              ["Polaris.icns", 0o644],
              ["CodeResources", 0o644],
            ]
          : []),
      ]);

      for (const file of build.files)
        expect(hash(Buffer.from(entries.find((e) => e.name === file.name)!.bytes))).toBe(
          file.sha256
        );
    }

    verifyDaemonArchives(dist);
  });

  test("a tampered archive or a dev manifest is refused", () => {
    const dist = daemonDist(VERSION);
    expect(() => verifyDownloadable(dist)).toThrow("no download URL");
    writeDaemonArchives(dist);
    writeFileSync(join(dist, RELEASE_DIR, `polaris-daemon-${VERSION}-linux-x64.tar.gz`), "x");
    expect(() => verifyDaemonArchives(dist)).toThrow("linux-x64: archive bytes differ");
  });
});

describe("staging the app's Daemon", () => {
  test("a release Mac bundles only darwin-arm64 and still lists every platform", () => {
    const dist = daemonDist(VERSION);
    writeDaemonArchives(dist);
    const dest = stage(dist, bundledPlatforms({ platform: "darwin", arch: "arm64" }, true));

    expect(readdirSync(dest).sort()).toEqual(["darwin-arm64", "manifest.json"]);
    verifyDaemonManifest(dest, VERSION);
    verifyDownloadable(dest);
    const builds = loadBuilds(dest);
    expect(builds.map((b) => b.platform)).toEqual([...PLATFORMS]);
    expect(builds.filter((b) => b.bundled).map((b) => b.platform)).toEqual(["darwin-arm64"]);
    expect(builds.every((b) => b.archive !== null)).toBe(true);
  });

  test("a release Windows x64 app bundles this PC's Daemon; Windows on Arm none", () => {
    const dist = daemonDist(VERSION);
    writeDaemonArchives(dist);
    const x64 = stage(dist, bundledPlatforms({ platform: "win32", arch: "x64" }, true));

    expect(readdirSync(x64).sort()).toEqual(["manifest.json", "windows-x64"]);
    verifyDaemonManifest(x64, VERSION);
    expect(
      loadBuilds(x64)
        .filter((b) => b.bundled)
        .map((b) => b.platform)
    ).toEqual(["windows-x64"]);

    const arm = stage(dist, bundledPlatforms({ platform: "win32", arch: "arm64" }, true));
    expect(readdirSync(arm)).toEqual(["manifest.json"]);
    expect(loadBuilds(arm).some((b) => b.bundled)).toBe(false);
  });

  test("dev builds bundle every platform and keep the manifest as built", () => {
    const dist = daemonDist(VERSION);
    const dest = stage(dist, bundledPlatforms({ platform: "darwin", arch: "arm64" }, false));

    expect(readdirSync(dest).sort()).toEqual([...PLATFORMS, "manifest.json"].sort());
    expect(readFileSync(join(dest, "manifest.json"))).toEqual(
      readFileSync(join(dist, "manifest.json"))
    );
    expect(loadBuilds(dest).every((b) => b.bundled && b.archive === null)).toBe(true);
    expect(existsSync(join(dest, RELEASE_DIR))).toBe(false);
  });
});
