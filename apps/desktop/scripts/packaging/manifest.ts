import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PLATFORMS } from "@polaris/client/install";
import { Schema } from "effect";
import { type Run, run } from "./command.ts";
import type { Signing } from "./release.ts";

const FileEntry = Schema.Struct({
  sha256: Schema.String,
  size: Schema.Number,
  executable: Schema.optional(Schema.Boolean),
  /** Where it is in the platform's directory when not at its name (macOS: in the app bundle). */
  path: Schema.optional(Schema.String),
});

type FileEntry = typeof FileEntry.Type;

/** Where a build's file is on disk: its `path` in the platform directory, else its name. */
export const buildFilePath = (dist: string, platform: string, name: string, entry: FileEntry) =>
  join(dist, platform, entry.path ?? name);

/** The `.app` whose `Contents/MacOS` holds `executable`; null when it isn't in one. */
export const appBundleOf = (executable: string): string | null => {
  const root = dirname(dirname(dirname(executable)));

  return executable.endsWith(`.app/Contents/MacOS/${basename(executable)}`) ? root : null;
};

/** "Polaris Computer Use.app": its launcher and the tools it runs (`service/computerUse/bundle.ts`). */
const HELPER_LAUNCHER = "polaris-computer-use";

const HELPER_TOOLS = ["agent-desktop", "agent-desktop-macos-helper"] as const;

const HELPER_ENTITLEMENTS = "computer-use.plist";

const Embedded = Schema.Struct({
  package: Schema.String,
  version: Schema.String,
  embedded: Schema.Boolean,
});

const Archive = Schema.Struct({ name: Schema.String, sha256: Schema.String, size: Schema.Number });

const Manifest = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  fff: Embedded,
  astGrep: Embedded,
  betterleaks: Schema.Struct({ version: Schema.String, file: Schema.String }),
  /** Release: where Hosts download each platform's archive (`archives.ts`). */
  download: Schema.optional(Schema.Struct({ url: Schema.String })),
  /** A staged app's platforms with files present; absent means all. */
  bundled: Schema.optional(Schema.Array(Schema.String)),
  platforms: Schema.Record(
    Schema.String,
    Schema.Struct({
      target: Schema.String,
      binary: Schema.String,
      sha256: Schema.String,
      files: Schema.Record(Schema.String, FileEntry),
      archive: Schema.optional(Archive),
    })
  ),
});

export type DaemonManifest = typeof Manifest.Type;

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));

export const readManifest = (dist: string) =>
  decodeManifest(readFileSync(join(dist, "manifest.json"), "utf8"));

export const fileFacts = (path: string) => ({
  sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  size: statSync(path).size,
});

const verifyRelease = (manifest: typeof Manifest.Type, version: string): void => {
  if (manifest.version !== version)
    throw new Error(
      `Daemon manifest version ${manifest.version} does not match release ${version}`
    );

  for (const platform of PLATFORMS) {
    if (!manifest.platforms[platform]) throw new Error(`release Daemon missing ${platform}`);
  }
};

export const verifyDaemonManifest = (dist: string, version?: string): void => {
  const manifest = readManifest(dist);

  if (version !== undefined) verifyRelease(manifest, version);

  for (const [platform, build] of Object.entries(manifest.platforms)) {
    if (build.sha256 !== build.files[build.binary]?.sha256)
      throw new Error(`${platform}: binary SHA differs from files entry`);

    // A release app carries only its own platform's files; the others are downloaded.
    if (manifest.bundled !== undefined && !manifest.bundled.includes(platform)) continue;

    for (const [name, entry] of Object.entries(build.files)) {
      const facts = fileFacts(buildFilePath(dist, platform, name, entry));

      if (facts.sha256 !== entry.sha256 || facts.size !== entry.size)
        throw new Error(`${platform}/${name}: bytes differ from Daemon manifest`);
    }
  }
};

export const signDaemonBuilds = (
  dist: string,
  signing: Signing | null,
  entitlementsDir: string,
  execute: Run = run
): void => {
  verifyDaemonManifest(dist);

  if (signing === null) return;

  const manifest = readManifest(dist);
  const build = manifest.platforms["darwin-arm64"];

  if (!build || build.binary !== "polaris" || !build.files.polaris || !build.files.betterleaks)
    throw new Error("missing darwin-arm64 polaris or betterleaks");

  const at = (name: string) => buildFilePath(dist, "darwin-arm64", name, build.files[name]!);
  const bundle = appBundleOf(at("polaris"));

  if (bundle === null) throw new Error("the darwin-arm64 Daemon is not in an app bundle (ENG-680)");

  const sign = (path: string, entitlements: string) => {
    execute([
      "codesign",
      "--force",
      "--sign",
      signing.identity,
      "--options",
      "runtime",
      "--timestamp",
      ...(signing.keychain ? ["--keychain", signing.keychain] : []),
      "--entitlements",
      join(entitlementsDir, entitlements),
      path,
    ]);
  };

  // Nested code first: the bundle's signature seals Betterleaks' as it is then.
  sign(at("betterleaks"), "betterleaks.plist");
  sign(bundle, "daemon.plist");
  execute(["codesign", "--verify", "--deep", "--strict", bundle]);

  // The computer use helper app beside it (ENG-846): its tools, then the bundle.
  if (!build.files[HELPER_LAUNCHER] || HELPER_TOOLS.some((tool) => !build.files[tool]))
    throw new Error("missing darwin-arm64 computer use helper");

  const helper = appBundleOf(at(HELPER_LAUNCHER));

  if (helper === null) throw new Error("the computer use helper is not in an app bundle");

  for (const tool of HELPER_TOOLS) sign(at(tool), HELPER_ENTITLEMENTS);
  sign(helper, HELPER_ENTITLEMENTS);
  execute(["codesign", "--verify", "--deep", "--strict", helper]);

  const files = Object.fromEntries(
    Object.entries(build.files).map(([name, entry]) => [name, { ...entry, ...fileFacts(at(name)) }])
  );

  const output = execute([at("polaris"), "selftest"]).trim();

  if (output.split("\n")[0] !== `polaris ${manifest.version} darwin-arm64`)
    throw new Error("signed Daemon selftest did not report the expected version and platform");

  execute([at("betterleaks"), "version"]);

  const signedManifest = {
    ...manifest,
    platforms: {
      ...manifest.platforms,
      "darwin-arm64": { ...build, sha256: files.polaris!.sha256, files },
    },
  };

  writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(signedManifest, null, 2)}\n`);
  verifyDaemonManifest(dist);
};
