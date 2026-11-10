#!/usr/bin/env bun
/**
 * Build the `polaris` Daemon for every platform it ships on (ENG-181):
 *
 *   apps/daemon/dist/<platform>/polaris       bun build --compile, one self-contained file (`polaris.exe` on Windows)
 *   apps/daemon/dist/<platform>/betterleaks   the pinned secrets scanner, checksum-verified (none on Windows yet)
 *   apps/daemon/dist/manifest.json            version, commit and SHA-256 per platform
 *
 * On macOS both executables live in `darwin-arm64/PolarisDaemon.app` (ENG-680,
 * `apps/daemon/src/service/bundle.ts`), signed as one bundle, and the manifest gives each
 * file's `path` there. No links: the release signer refuses them in its hand-off.
 * Beside it is `Polaris Computer Use.app` (ENG-846, `service/computerUse/`): a launcher
 * compiled here with clang and the pinned agent-desktop, signed as a second bundle. A dev
 * build's has its own bundle id, so dev and release never share a privacy grant.
 *
 * fff's native library (`@ff-labs/fff-bun`, MIT) is embedded by the compile
 * step: fff-bun imports `@ff-labs/fff-bin-<platform>/libfff_c.*` with
 * `{ type: "file" }`, so the target platform's package must be installed at
 * build time (optional dependencies for other platforms are not installed by
 * default; this script installs them from the lockfile when missing), and
 * Linux builds need `--define FFF_LIBC="gnu"` (or `"musl"`) to pick the library.
 * ast-grep's addon and grammars (the Rules, `apps/daemon/src/rules/`) are
 * embedded the same way, from `@ast-grep/napi-<platform>` and `@ast-grep/lang-*`; every
 * `napi-*` that `native.ts` requires must be installed, since the bundler resolves them all.
 * libsodium (sodium-native, the Relay route's crypto) is embedded the same way:
 * `patches/sodium-native@5.2.0.patch` gives it literal per-platform requires.
 * Betterleaks is a Go binary that can't run from inside `polaris`: it is
 * downloaded at its pinned version (`apps/daemon/src/rules/secrets/pin.ts`),
 * checked against its SHA-256, and listed in the manifest as an executable.
 *
 *   bun scripts/build-daemon.ts [--release] [--out=<dir>] [darwin-arm64|linux-x64|linux-arm64|linux-x64-musl|linux-arm64-musl|windows-x64 ...]
 *
 * `--out` builds into `<dir>` instead of `apps/daemon/dist`.
 *
 * Without `--release` it is a dev build: its version names the commit
 * (`buildVersion.ts`), so a Client upgrades a Host from one dev build to the next.
 * The version is compiled in (`process.env.POLARIS_BUILD_VERSION`, read by `service/platform.ts`).
 * So is a sourcemap, which Bun applies to `Error.stack` (`daemonBundle.ts`, ENG-752).
 *
 * A darwin build embeds no native library (ENG-877, ADR 0105,
 * `apps/daemon/src/service/bundleLibraries.ts`): Bun would write each to the temp directory
 * and load whatever file has its name and size. fff's, ast-grep's addon and grammars and
 * libsodium are files in `PolarisDaemon.app/Contents/Frameworks`, which the release signer
 * signs, and the build fails when the Daemon loads a library from anywhere else.
 *
 * A darwin release build's Bun runtime is sealed (ENG-875, ADR 0105,
 * `apps/daemon/src/service/sealedRuntime.ts`): `BUN_BE_BUN`, `BUN_OPTIONS` and `BUN_INSPECT*`
 * no longer make the signed binary run foreign JavaScript. The build fails when they still do.
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
import { dirname, join, resolve } from "node:path";
import { Option, Schema } from "effect";
import {
  BUNDLE_FILES,
  type BundleFile,
  DAEMON_BUNDLE,
  DAEMON_ICON,
  infoPlist,
} from "../apps/daemon/src/service/bundle.ts";
import { installAgentDesktop } from "../apps/daemon/src/install/agentDesktop/install.ts";
import { buildHelper } from "../apps/daemon/src/service/computerUse/build.ts";
import {
  COMPUTER_USE_BUNDLE,
  HELPER_EXECUTABLES,
  HELPER_FILES,
} from "../apps/daemon/src/service/computerUse/bundle.ts";
import {
  bundleLibrariesPlugin,
  embeddedLibraries,
  foreignLibraries,
  loadedLibraries,
  placeBundleLibraries,
} from "../apps/daemon/src/service/bundleLibraries.ts";
import { AGENT_DESKTOP_VERSION } from "../apps/daemon/src/install/agentDesktop/pin.ts";
import { openRoutes, sealRuntime } from "../apps/daemon/src/service/sealedRuntime.ts";
import { fetchBetterleaks } from "../apps/daemon/src/rules/secrets/fetch.ts";
import { BETTERLEAKS_VERSION, betterleaksAsset } from "../apps/daemon/src/rules/secrets/pin.ts";
import { buildVersion } from "./buildVersion.ts";
import { buildFromRoot, DAEMON_BUILD_OPTIONS } from "./daemonBundle.ts";
import { instrumentationPlugin } from "../apps/daemon/src/traces/instrumentation/build.ts";

const root = join(import.meta.dir, "..");

const daemonDir = join(root, "apps", "daemon");

const OUT_FLAG = "--out=";

const outFlag = process.argv.find((arg) => arg.startsWith(OUT_FLAG));

const distDir =
  outFlag === undefined ? join(daemonDir, "dist") : resolve(outFlag.slice(OUT_FLAG.length));

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
  path: Schema.optional(Schema.String),
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

/**
 * Every `@ast-grep/napi-*` addon `native.ts` requires: the bundler resolves the branches
 * the target's defines can't remove, so a darwin build still needs Linux's (ENG-681).
 */
const astGrepAddons = (): ReadonlyArray<string> => {
  const source = readFileSync(join(daemonDir, "src", "rules", "patterns", "native.ts"), "utf8");

  const names = Array.from(
    source.matchAll(/require\("(@ast-grep\/napi-[^/"]+)\//g),
    ([, name]) => name
  );

  return [...new Set(names.filter((name) => name !== undefined))];
};

/** ast-grep's addons, optional dependencies of the Daemon; `platform`'s own is among them. */
const astGrepInstalled = (platform: Platform): boolean => {
  const addons = astGrepAddons();

  if (!addons.includes(`@ast-grep/napi-${PLATFORMS[platform].astGrep}`)) {
    throw new Error(`native.ts no longer requires @ast-grep/napi-${PLATFORMS[platform].astGrep}`);
  }

  return addons.every((addon) => findPackage(daemonDir, addon) !== null);
};

/** The bundler resolves every platform's ast-grep addon, whichever one it builds. */
const everyAstGrepInstalled = () =>
  Object.keys(PLATFORMS).filter(isPlatform).every(astGrepInstalled);

const targetPackagesInstalled = (platform: Platform) =>
  fffBinInstalled(platform) && everyAstGrepInstalled();

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
 * 137). Re-sign the app bundle ad hoc. Needs macOS `codesign`, so darwin builds run on macOS.
 */
const signAdHoc = async (bundle: string) => {
  if (process.platform !== "darwin") {
    throw new Error("darwin builds must run on macOS (codesign is needed to re-sign the binary)");
  }

  await run(["codesign", "--force", "--sign", "-", bundle]);
  await run(["codesign", "--verify", "--deep", "--strict", bundle]);
};

/** Betterleaks beside the binary; null for a platform without a pinned release (Windows, ENG-296). */
const bundleBetterleaks = async (platform: Platform, dir: string): Promise<string | null> => {
  const asset = betterleaksAsset(platform);

  if (asset === null) return null;
  const betterleaks = join(dir, "betterleaks");
  copyFileSync(await fetchBetterleaks(asset), betterleaks);
  chmodSync(betterleaks, 0o755);

  return betterleaks;
};

/** The app bundle's Info.plist and icon, then its ad-hoc signature. */
const finishBundle = async (outDir: string, version: string) => {
  const bundle = join(outDir, DAEMON_BUNDLE);
  const at = (name: BundleFile) => join(bundle, BUNDLE_FILES[name]);

  writeFileSync(at("Info.plist"), infoPlist(version));
  mkdirSync(dirname(at(DAEMON_ICON)), { recursive: true });
  copyFileSync(join(root, "design", "assets", "app-icon", DAEMON_ICON), at(DAEMON_ICON));
  await signAdHoc(bundle);
};

/** The helper app beside the Daemon's bundle, holding the pinned agent-desktop for `platform`. */
const bundleHelper = async (
  platform: Platform,
  outDir: string,
  version: string,
  release: boolean
) => {
  const { binary } = await installAgentDesktop({
    root: join(root, "node_modules", ".cache", "polaris-agent-desktop", platform),
    platform,
  });

  const helper = await buildHelper({
    dir: outDir,
    version,
    release,
    inputs: {
      "agent-desktop": binary,
      "agent-desktop-macos-helper": join(dirname(binary), "agent-desktop-macos-helper"),
      "computer-use-Polaris.icns": join(root, "design", "assets", "app-icon", DAEMON_ICON),
    },
  });

  if (platform !== hostPlatform) return;
  // Run directly: the launcher serves only the Daemon (ENG-867), and a build is not one.
  const output = await run([join(helper, HELPER_FILES["agent-desktop"]), "version"]);

  if (!output.includes(`"version":"${AGENT_DESKTOP_VERSION}"`))
    throw new Error(`the helper's agent-desktop printed "${output.trim()}"`);
  console.log(`  computer use helper: ok (agent-desktop ${AGENT_DESKTOP_VERSION})`);
};

type FileEntry = typeof FileEntry.Type;

const EXECUTABLES: ReadonlySet<string> = new Set(["betterleaks", ...HELPER_EXECUTABLES]);

/** A build's file: executables beside `polaris` are marked, and a file not at its name gets its `path`. */
const fileEntry = (outDir: string, name: string, path: string): FileEntry => {
  const full = join(outDir, path);
  const facts = { sha256: sha256(full), size: statSync(full).size };
  const entry = EXECUTABLES.has(name) ? { ...facts, executable: true } : facts;

  return path === name ? entry : { ...entry, path };
};

/** Each file of a build by name, at its path inside the platform's directory. */
const fileEntries = (outDir: string, paths: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, fileEntry(outDir, name, path)])
  );

/** Where each file of a darwin build is inside the platform directory. */
const bundlePaths = (betterleaks: boolean): Record<string, string> =>
  Object.fromEntries<string>([
    ...Object.entries(BUNDLE_FILES)
      .filter(([name]) => betterleaks || name !== "betterleaks")
      .map(([name, path]): [string, string] => [name, join(DAEMON_BUNDLE, path)]),
    ...Object.entries(HELPER_FILES).map(([name, path]): [string, string] => [
      name,
      join(COMPUTER_USE_BUNDLE, path),
    ]),
  ]);

/** Fails the build when the darwin Daemon would load a library from outside its bundle and macOS. */
const assertOwnLibraries = async (binary: string, expected: string) => {
  const embedded = embeddedLibraries(binary);

  if (embedded > 0) {
    throw new Error(`${binary} embeds ${embedded} native libraries: see docs/adr/0105 (ENG-877)`);
  }

  if (expected === "") return;
  const { stdout, images } = await loadedLibraries(binary, ["selftest"]);
  const foreign = foreignLibraries(binary, images);

  if (stdout.split("\n")[0] !== expected || foreign.length > 0) {
    throw new Error(
      `${binary} selftest printed "${stdout.trim()}" and loaded ${foreign.join(", ") || "no foreign library"} (ENG-877)`
    );
  }

  console.log("  native libraries: ok (none embedded, all from the bundle or macOS)");
};

/** Fails the build when the built Daemon still runs a script its environment names. */
const assertSealed = async (binary: string) => {
  const open = await openRoutes(binary, { command: ["version"], names: "bun" });

  if (open.length > 0) {
    throw new Error(`${binary} runs foreign JavaScript through ${open.join(", ")} (ADR 0105)`);
  }

  console.log("  sealed runtime: ok (BUN_BE_BUN, BUN_OPTIONS, BUN_INSPECT)");
};

/** Runs the built Daemon where this machine can, and fails the build on what it must never do. */
const checkBuild = async (platform: Platform, binary: string, version: string, sealed: boolean) => {
  const expected = `polaris ${version} ${platform}`;
  const runs = platform === hostPlatform;

  if (runs) {
    // `selftest` also proves fff's library, the Rules' addon and libsodium load.
    const output = (await run([binary, "selftest"])).trim();

    if (output.split("\n")[0] !== expected) {
      throw new Error(`${binary} selftest printed "${output}", expected "${expected}" first`);
    }

    console.log(output.replaceAll(/^/gm, "  "));

    if (sealed) await assertSealed(binary);
  }

  if (platform.startsWith("darwin")) await assertOwnLibraries(binary, runs ? expected : "");
};

const build = async (
  platform: Platform,
  version: string,
  release: boolean
): Promise<PlatformBuild> => {
  const { target, define } = PLATFORMS[platform];
  const outDir = join(distDir, platform);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const name = binaryName(platform);
  const darwin = platform.startsWith("darwin");
  const binDir = darwin ? dirname(join(outDir, DAEMON_BUNDLE, BUNDLE_FILES.polaris)) : outDir;
  const binary = join(binDir, name);

  const instrumentation = await instrumentationPlugin();
  const libraries = darwin ? bundleLibrariesPlugin() : null;

  const result = await buildFromRoot(root, {
    ...DAEMON_BUILD_OPTIONS,
    entrypoints: [
      join(daemonDir, "src", "main.ts"),
      // The fff worker (apps/daemon/src/files/search/fff.ts) is its own entrypoint.
      join(daemonDir, "src", "files", "search", "fffWorker.ts"),
      join(daemonDir, "src", "traces", "worker.ts"),
      join(daemonDir, "src", "traces", "profiles", "worker.ts"),
    ],
    compile: { target, outfile: binary, autoloadDotenv: false, autoloadBunfig: false },
    define: {
      ...Object.fromEntries(
        define.map((value) => {
          const index = value.indexOf("=");

          return [value.slice(0, index), value.slice(index + 1)];
        })
      ),
      "process.env.POLARIS_BUILD_VERSION": JSON.stringify(version),
    },
    plugins: libraries === null ? [instrumentation] : [instrumentation, libraries],
  });

  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  instrumentation.assertEmbedded();

  // Before the bundle is signed: its signature seals them.
  if (libraries !== null) placeBundleLibraries(join(outDir, DAEMON_BUNDLE), libraries.sources);
  const sealed = darwin && release;

  // Before the bundle is signed: the seal changes the executable's bytes.
  if (sealed) sealRuntime(binary);

  const betterleaks = await bundleBetterleaks(platform, binDir);

  if (darwin) {
    await finishBundle(outDir, version);
    await bundleHelper(platform, outDir, version, release);
  }

  await checkBuild(platform, binary, version, sealed);

  const flat =
    betterleaks === null ? { [name]: name } : { [name]: name, betterleaks: "betterleaks" };

  return {
    target,
    binary: name,
    sha256: sha256(binary),
    files: fileEntries(outDir, darwin ? bundlePaths(betterleaks !== null) : flat),
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const release = args.includes("--release");
  const requested = args.filter((arg) => arg !== "--release" && !arg.startsWith(OUT_FLAG));
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
    built[platform] = await build(platform, version, release);
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
