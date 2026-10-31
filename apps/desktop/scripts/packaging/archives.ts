/**
 * Release Daemons as downloads (docs/adr/0043): one `.tar.gz` per platform plus
 * a checksums file under `apps/daemon/dist/release/`, recorded in the manifest,
 * and a staged app that bundles only its own platform's files.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DAEMON_DOWNLOAD_URL,
  daemonArchiveName,
  isPlatform,
  packArchive,
  PLATFORMS,
  type Platform,
} from "@polaris/client/install";
import { buildFilePath, type DaemonManifest, fileFacts, readManifest } from "./manifest.ts";
import type { PackageTarget } from "./targets.ts";

/** Under the Daemon dist; never staged into an app. */
export const RELEASE_DIR = "release";

export const daemonChecksumsName = (version: string) => `polaris-daemon-${version}-SHA256SUMS`;

const writeManifest = (dist: string, manifest: DaemonManifest) =>
  writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

/**
 * Packs each platform's final (signed) files into its Release archive, records
 * each archive's SHA-256 and size and the download URL in the manifest, and writes
 * the checksums file. Returns the paths to upload.
 */
export const writeDaemonArchives = (dist: string): string[] => {
  const manifest = readManifest(dist);
  const out = join(dist, RELEASE_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const platforms: Record<string, DaemonManifest["platforms"][string]> = {};
  const sums: string[] = [];
  const uploads: string[] = [];

  for (const [platform, build] of Object.entries(manifest.platforms)) {
    if (!isPlatform(platform)) throw new Error(`unknown Daemon platform ${platform}`);
    const names = [build.binary, ...Object.keys(build.files).filter((n) => n !== build.binary)];

    const archive = packArchive(
      names.map((name) => ({
        name,
        mode: name === build.binary || build.files[name]!.executable ? 0o755 : 0o644,
        bytes: readFileSync(buildFilePath(dist, platform, name, build.files[name]!)),
      }))
    );

    const name = daemonArchiveName(manifest.version, platform);
    writeFileSync(join(out, name), archive);
    const facts = fileFacts(join(out, name));
    platforms[platform] = { ...build, archive: { name, ...facts } };
    sums.push(`${facts.sha256}  ${name}`);
    uploads.push(join(out, name));
  }

  const checksums = join(out, daemonChecksumsName(manifest.version));
  writeFileSync(checksums, `${sums.join("\n")}\n`);
  writeManifest(dist, { ...manifest, download: { url: DAEMON_DOWNLOAD_URL }, platforms });
  verifyDaemonArchives(dist);

  return [...uploads, checksums];
};

/** Every platform of a release manifest can be downloaded: an archive entry and the URL. */
export const verifyDownloadable = (dist: string): void => {
  const manifest = readManifest(dist);

  if (manifest.download === undefined)
    throw new Error("release Daemon manifest has no download URL");

  for (const platform of PLATFORMS) {
    if (manifest.platforms[platform]?.archive === undefined)
      throw new Error(`release Daemon manifest has no archive for ${platform}`);
  }
};

/** The archives on disk are the bytes the manifest records. */
export const verifyDaemonArchives = (dist: string): void => {
  verifyDownloadable(dist);

  for (const [platform, build] of Object.entries(readManifest(dist).platforms)) {
    const archive = build.archive;

    if (archive === undefined) throw new Error(`${platform}: no archive in the Daemon manifest`);
    const facts = fileFacts(join(dist, RELEASE_DIR, archive.name));

    if (facts.sha256 !== archive.sha256 || facts.size !== archive.size)
      throw new Error(`${platform}: archive bytes differ from the Daemon manifest`);
  }
};

/** The platforms whose files an app bundles: a release only the Client's own, dev all. */
export const bundledPlatforms = (target: PackageTarget, release: boolean): Platform[] | null => {
  if (!release) return null;

  if (target.platform === "darwin") return ["darwin-arm64"];

  if (target.platform === "linux") return [target.arch === "arm64" ? "linux-arm64" : "linux-x64"];

  // This PC runs the x64 Daemon; Windows on Arm has none yet. WSL distros download theirs.
  return target.arch === "x64" ? ["windows-x64"] : [];
};

/**
 * Copies the Daemon dist into `dest` (the app's `Resources/daemon`): each platform's
 * manifest files at their paths, never the dist's convenience links (the packager would
 * point them at this machine). With a platform list, only those go, and the manifest says so.
 */
export const stageDaemon = (dist: string, dest: string, bundled: Platform[] | null): void => {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const manifest = readManifest(dist);
  const platforms = bundled ?? Object.keys(manifest.platforms);

  for (const platform of platforms) {
    for (const [name, entry] of Object.entries(manifest.platforms[platform]?.files ?? {})) {
      const target = buildFilePath(dest, platform, name, entry);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(buildFilePath(dist, platform, name, entry), target);
    }
  }

  if (bundled === null) cpSync(join(dist, "manifest.json"), join(dest, "manifest.json"));
  else writeManifest(dest, { ...manifest, bundled });
};
