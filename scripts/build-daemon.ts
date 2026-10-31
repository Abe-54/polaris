#!/usr/bin/env bun
/**
 * Build the `polaris` Daemon for every platform it ships on (ENG-181):
 *
 *   apps/daemon/dist/<platform>/polaris       bun build --compile, one self-contained file (`polaris.exe` on Windows)
 *   apps/daemon/dist/<platform>/betterleaks   the pinned secrets scanner, checksum-verified (none on Windows yet)
 *   apps/daemon/dist/manifest.json            version, commit and SHA-256 per platform
 *
 * fff's native library (`@ff-labs/fff-bun`, MIT) is embedded by the compile
 * step: fff-bun imports `@ff-labs/fff-bin-<platform>/libfff_c.*` with
 * `{ type: "file" }`, so the target platform's package must be installed at
 * build time (optional dependencies for other platforms are not installed by
 * default; this script installs them from the lockfile when missing), and
 * Linux builds need `--define FFF_LIBC="gnu"` (or `"musl"`) to pick the library.
 * ast-grep's addon and grammars (the Rules, `apps/daemon/src/rules/`) are
 * embedded the same way, from `@ast-grep/napi-<platform>` and `@ast-grep/lang-*`.
 * libsodium (sodium-native, the Relay route's crypto) is embedded the same way:
 * `patches/sodium-native@5.2.0.patch` gives it literal per-platform requires.
 * Betterleaks is a Go binary that can't run from inside `polaris`: it is
 * downloaded at its pinned version (`apps/daemon/src/rules/secrets/pin.ts`),
 * checked against its SHA-256, and listed in the manifest as an executable.
 *
 *   bun scripts/build-daemon.ts [--release] [darwin-arm64|linux-x64|linux-arm64|linux-x64-musl|linux-arm64-musl|windows-x64 ...]
 *
 * Without `--release` it is a dev build: its version names the commit
 * (`buildVersion.ts`), so a Client upgrades a Host from one dev build to the next.
 * The version is compiled in (`process.env.POLARIS_BUILD_VERSION`, read by `service/platform.ts`).
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Option, Schema } from "effect";
import { fetchBetterleaks } from "../apps/daemon/src/rules/secrets/fetch.ts";
import { BETTERLEAKS_VERSION, betterleaksAsset } from "../apps/daemon/src/rules/secrets/pin.ts";
import { buildVersion } from "./buildVersion.ts";

const root = join(import.meta.dir, "..");

const daemonDir = join(root, "apps", "daemon");

const distDir = join(daemonDir, "dist");

const GNU = ['FFF_LIBC="gnu"', 'process.env.POLARIS_LIBC="gnu"'];

const MUSL = ['FFF_LIBC="musl"', 'process.env.POLARIS_LIBC="musl"'];

const PLATFORMS = {
  "darwin-arm64": {
    target: "bun-darwin-arm64",
    fffBin: "darwin-arm64",
    astGrep: "darwin-arm64",
    define: [],
  },
  "linux-x64": {
    target: "bun-linux-x64",
    fffBin: "linux-x64-gnu",
    astGrep: "linux-x64-gnu",
    define: GNU,
  },
  "linux-arm64": {
    target: "bun-linux-arm64",
    fffBin: "linux-arm64-gnu",
    astGrep: "linux-arm64-gnu",
    define: GNU,
  },
  // musl (Alpine). Bun's musl runtime links libstdc++ and libgcc dynamically,
  // so the Host needs `apk add libstdc++ libgcc`; the Client's probe checks.
  "linux-x64-musl": {
    target: "bun-linux-x64-musl",
    fffBin: "linux-x64-musl",
    astGrep: "linux-x64-musl",
    define: MUSL,
  },
  "linux-arm64-musl": {
    target: "bun-linux-arm64-musl",
    fffBin: "linux-arm64-musl",
    astGrep: "linux-arm64-musl",
    define: MUSL,
  },
  // No Betterleaks pin for Windows until ENG-296: the Daemon reports secret scanning unavailable.
  "windows-x64": {
    target: "bun-windows-x64",
    fffBin: "win32-x64",
    astGrep: "win32-x64-msvc",
    define: [],
  },
} as const;

type Platform = keyof typeof PLATFORMS;

const isPlatform = (name: string): name is Platform => Object.hasOwn(PLATFORMS, name);

const decodeVersioned = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
);

const FileEntry = Schema.Struct({
  sha256: Schema.String,
  size: Schema.Number,
  executable: Schema.optional(Schema.Boolean),
});

const PlatformBuild = Schema.Struct({
  target: Schema.String,
  binary: Schema.String,
  sha256: Schema.String,
  files: Schema.Record(Schema.String, FileEntry),
});

type PlatformBuild = typeof PlatformBuild.Type;

/** The parts of a previous `manifest.json` a rebuild keeps. */
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      commit: Schema.String,
      platforms: Schema.Record(Schema.String, PlatformBuild),
    })
  )
);

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const run = async (argv: ReadonlyArray<string>, cwd = root) => {
  const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}\n${stderr || stdout}`);

  return stdout;
};

/** Node-style lookup from `fromDir` (real path) upwards, without require's caches. */
const findPackage = (fromDir: string, name: string): string | null => {
  let dir = realpathSync(fromDir);

  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");

    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);

    if (parent === dir) return null;
    dir = parent;
  }
};

const readVersion = (packageJson: string): string =>
  decodeVersioned(readFileSync(packageJson, "utf8")).version;

/** fff-bun's package.json; the bundler resolves fff-bin-* from its directory. */
const fffBunPackage = (): string => {
  const found = findPackage(daemonDir, "@ff-labs/fff-bun");

  if (found === null) throw new Error("@ff-labs/fff-bun is not installed: run bun install");

  return found;
};

const fffBinInstalled = (platform: Platform): boolean => {
  const fffBun = fffBunPackage();
  const bin = findPackage(dirname(fffBun), `@ff-labs/fff-bin-${PLATFORMS[platform].fffBin}`);

  return bin !== null && readVersion(bin) === readVersion(fffBun);
};

/** ast-grep's addon for `platform`: `@ast-grep/napi-<fffBin>`, an optional dependency of the Daemon. */
const astGrepInstalled = (platform: Platform): boolean =>
  findPackage(daemonDir, `@ast-grep/napi-${PLATFORMS[platform].astGrep}`) !== null;

const targetPackagesInstalled = (platform: Platform) =>
  fffBinInstalled(platform) && astGrepInstalled(platform);

/** Install the target platforms' optional packages (fff-bin-*, ast-grep's napi-*) from the lockfile. */
const ensureTargetPackages = async (platforms: ReadonlyArray<Platform>) => {
  const missing = platforms.filter((platform) => !targetPackagesInstalled(platform));

  if (missing.length === 0) return;
  console.log(
    `installing optional packages for ${missing.join(", ")} (bun install --os=* --cpu=*)`
  );
  await run([process.execPath, "install", "--frozen-lockfile", "--os=*", "--cpu=*"]);
  const still = missing.filter((platform) => !targetPackagesInstalled(platform));

  if (still.length > 0) {
    throw new Error(
      `@ff-labs/fff-bin-* or @ast-grep/napi-* still missing for ${still.join(", ")} after install`
    );
  }
};

const onMusl = (() => {
  try {
    return (
      process.platform === "linux" && readdirSync("/lib").some((f) => f.startsWith("ld-musl-"))
    );
  } catch {
    return false;
  }
})();

const hostOs = process.platform === "win32" ? "windows" : process.platform;

const hostPlatform = `${hostOs}-${process.arch}${onMusl ? "-musl" : ""}`;

/** The Daemon's file name: Windows runs only `.exe` files. */
const binaryName = (platform: Platform) =>
  platform.startsWith("windows") ? "polaris.exe" : "polaris";

/**
 * Bun appends the bundle after linking, which leaves the linker's ad-hoc
 * signature invalid; recent macOS kills such binaries on exec (SIGKILL, exit
 * 137). Re-sign ad hoc. Needs macOS `codesign`, so darwin builds run on macOS.
 */
const signAdHoc = async (binary: string) => {
  if (process.platform !== "darwin") {
    throw new Error("darwin builds must run on macOS (codesign is needed to re-sign the binary)");
  }

  await run(["codesign", "--force", "--sign", "-", binary]);
  await run(["codesign", "--verify", "--strict", binary]);
};

/** Betterleaks beside the binary; null for a platform without a pinned release (Windows, ENG-296). */
const bundleBetterleaks = async (platform: Platform, outDir: string): Promise<string | null> => {
  const asset = betterleaksAsset(platform);

  if (asset === null) return null;
  const betterleaks = join(outDir, "betterleaks");
  copyFileSync(await fetchBetterleaks(asset), betterleaks);
  chmodSync(betterleaks, 0o755);

  return betterleaks;
};

const build = async (platform: Platform, version: string): Promise<PlatformBuild> => {
  const { target, define } = PLATFORMS[platform];
  const outDir = join(distDir, platform);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const name = binaryName(platform);
  const binary = join(outDir, name);
  await run([
    process.execPath,
    "build",
    join(daemonDir, "src", "main.ts"),
    // The fff worker (apps/daemon/src/files/search/fff.ts) is its own entrypoint.
    join(daemonDir, "src", "files", "search", "fffWorker.ts"),
    join(daemonDir, "src", "traces", "worker.ts"),
    "--compile",
    `--target=${target}`,
    "--minify",
    // Lazily imported commands and Harness drivers become separate chunks, parsed only
    // when imported: `serve` never parses the Claude Agent SDK, `bridge` not the Daemon.
    "--splitting",
    ...define.map((value) => `--define=${value}`),
    `--define=process.env.POLARIS_BUILD_VERSION=${JSON.stringify(version)}`,
    `--outfile=${binary}`,
  ]);

  if (platform.startsWith("darwin")) await signAdHoc(binary);
  const betterleaks = await bundleBetterleaks(platform, outDir);

  if (platform === hostPlatform) {
    // `selftest` also proves the embedded fff library loads and searches.
    const output = (await run([binary, "selftest"])).trim();
    const expected = `polaris ${version} ${platform}`;

    if (output.split("\n")[0] !== expected) {
      throw new Error(`${binary} selftest printed "${output}", expected "${expected}" first`);
    }

    console.log(output.replaceAll(/^/gm, "  "));
  }

  const daemon = { sha256: sha256(binary), size: statSync(binary).size };

  const files =
    betterleaks === null
      ? { [name]: daemon }
      : {
          [name]: daemon,
          betterleaks: {
            sha256: sha256(betterleaks),
            size: statSync(betterleaks).size,
            executable: true,
          },
        };

  return {
    target,
    binary: name,
    sha256: sha256(binary),
    files,
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const release = args.includes("--release");
  const requested = args.filter((arg) => arg !== "--release");
  const unknown = requested.filter((platform) => !isPlatform(platform));

  if (unknown.length > 0) throw new Error(`unknown platform(s): ${unknown.join(", ")}`);
  const platforms = (requested.length > 0 ? requested : Object.keys(PLATFORMS)).filter(isPlatform);

  const commit = (await run(["git", "rev-parse", "HEAD"]).catch(() => "unknown")).trim();

  const version = buildVersion(readVersion(join(daemonDir, "package.json")), {
    release,
    commit: {
      count: Number((await run(["git", "rev-list", "--count", "HEAD"]).catch(() => "0")).trim()),
      sha: commit.slice(0, 7),
      dirty: (await run(["git", "status", "--porcelain"]).catch(() => "")).trim() !== "",
    },
    now: new Date(),
  });

  const fff = readVersion(fffBunPackage());
  const astGrep = readVersion(findPackage(daemonDir, "@ast-grep/napi")!);
  await ensureTargetPackages(platforms);

  const manifestPath = join(distDir, "manifest.json");

  const previous = existsSync(manifestPath)
    ? Option.getOrNull(decodeManifest(readFileSync(manifestPath, "utf8")))
    : null;

  const built: Record<string, PlatformBuild> =
    previous?.version === version && previous.commit === commit ? { ...previous.platforms } : {};

  for (const platform of platforms) {
    const started = performance.now();
    built[platform] = await build(platform, version);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`built ${platform} in ${seconds}s`);
  }

  const manifest = {
    version,
    commit,
    fff: { package: "@ff-labs/fff-bun", version: fff, embedded: true },
    astGrep: { package: "@ast-grep/napi", version: astGrep, embedded: true },
    betterleaks: { version: BETTERLEAKS_VERSION, file: "betterleaks" },
    platforms: built,
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${manifestPath}`);
};

await main();
