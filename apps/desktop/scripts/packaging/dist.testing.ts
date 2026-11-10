/**
 * A Daemon build directory for the packaging tests: every platform's `polaris`
 * and `betterleaks` (macOS's in its app bundle, with the computer use helper app beside it)
 * plus the manifest that describes them.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLATFORMS } from "@polaris/client/install";
import { readManifest } from "./manifest.ts";

export const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const dists: string[] = [];

/** Removes every directory `daemonDist` made; call it from `afterEach`. */
export const removeDists = () => {
  for (const dir of dists.splice(0)) rmSync(dir, { recursive: true, force: true });
};

/** Where macOS's files are in the app bundle, as `scripts/build-daemon.ts` writes them. */
export const DARWIN_PATHS = {
  polaris: "PolarisDaemon.app/Contents/MacOS/polaris",
  betterleaks: "PolarisDaemon.app/Contents/MacOS/betterleaks",
  "libfff_c.dylib": "PolarisDaemon.app/Contents/Frameworks/libfff_c.dylib",
  "sodium-native.node": "PolarisDaemon.app/Contents/Frameworks/sodium-native.node",
  "Info.plist": "PolarisDaemon.app/Contents/Info.plist",
  "Polaris.icns": "PolarisDaemon.app/Contents/Resources/Polaris.icns",
  CodeResources: "PolarisDaemon.app/Contents/_CodeSignature/CodeResources",
  "polaris-computer-use": "Polaris Computer Use.app/Contents/MacOS/polaris-computer-use",
  "agent-desktop": "Polaris Computer Use.app/Contents/MacOS/agent-desktop",
  "agent-desktop-macos-helper":
    "Polaris Computer Use.app/Contents/MacOS/agent-desktop-macos-helper",
  "computer-use-Info.plist": "Polaris Computer Use.app/Contents/Info.plist",
  "computer-use-Polaris.icns": "Polaris Computer Use.app/Contents/Resources/Polaris.icns",
  "computer-use-CodeResources": "Polaris Computer Use.app/Contents/_CodeSignature/CodeResources",
} satisfies Record<string, string>;

const EXECUTABLES = new Set([
  "betterleaks",
  "polaris-computer-use",
  "agent-desktop",
  "agent-desktop-macos-helper",
]);

/** Each file a platform's build has, and its path in the platform directory. */
const filePaths = (platform: string): ReadonlyArray<readonly [string, string | null]> =>
  platform === "darwin-arm64"
    ? Object.entries(DARWIN_PATHS)
    : [
        ["polaris", null],
        ["betterleaks", null],
      ];

const platformFiles = (dist: string, platform: string) =>
  Object.fromEntries(
    filePaths(platform).map(([name, path]) => {
      const bytes = `${platform}/${name}`;
      const at = join(dist, platform, path ?? name);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, bytes);

      const entry = {
        sha256: hash(bytes),
        size: Buffer.byteLength(bytes),
        executable: EXECUTABLES.has(name),
      };

      return [name, path === null ? entry : { ...entry, path }];
    })
  );

export const daemonDist = (version: string) => {
  const dist = mkdtempSync(join(tmpdir(), "polaris-dist-test-"));
  dists.push(dist);

  const platforms = Object.fromEntries(
    PLATFORMS.map((platform) => {
      mkdirSync(join(dist, platform));
      const files = platformFiles(dist, platform);

      return [
        platform,
        {
          target: `bun-${platform}`,
          binary: "polaris",
          sha256: hash(`${platform}/polaris`),
          files,
        },
      ];
    })
  );

  writeFileSync(
    join(dist, "manifest.json"),
    JSON.stringify({
      version,
      commit: "commit",
      fff: { package: "fff", version: "1", embedded: true },
      astGrep: { package: "ast-grep", version: "1", embedded: true },
      betterleaks: { version: "1", file: "betterleaks" },
      platforms,
    })
  );

  return dist;
};

/** Rewrites `dist`'s manifest without one of the macOS build's files. */
export const dropDarwinFile = (dist: string, name: keyof typeof DARWIN_PATHS) => {
  const path = join(dist, "manifest.json");
  const manifest = readManifest(dist);
  const build = manifest.platforms["darwin-arm64"]!;
  const files = Object.fromEntries(Object.entries(build.files).filter(([file]) => file !== name));
  const platforms = { ...manifest.platforms, "darwin-arm64": { ...build, files } };
  writeFileSync(path, JSON.stringify({ ...manifest, platforms }));
};
