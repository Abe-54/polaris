/**
 * A darwin Daemon's native libraries ship as files in its bundle (ENG-877, ADR 0108). Bun
 * writes an embedded library to the temp directory before it loads it and reuses any file of
 * that name and size, so a compiled darwin Daemon embeds none: the build keeps them out with
 * `bundleLibrariesPlugin` and copies them to `Contents/Frameworks`, where the release signer
 * signs them. Library validation then refuses every other library. Used by
 * `scripts/build-daemon.ts`.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";
import {
  BUNDLE_FILES,
  BUNDLE_LIBRARY_DIR,
  BUNDLE_LIBRARY_NAMES,
  type BundleLibrary,
  bundleOf,
} from "./bundle.ts";
import { embeddedProgram } from "./sealedRuntime.ts";
import { childEnv } from "./childEnv.ts";

/** Each library's file in `node_modules`, as the Daemon's code and its packages import it. */
export const BUNDLE_LIBRARY_SOURCES: Record<BundleLibrary, string> = {
  "libfff_c.dylib": "@ff-labs/fff-bin-darwin-arm64/libfff_c.dylib",
  "ast-grep-napi.darwin-arm64.node": "@ast-grep/napi-darwin-arm64/ast-grep-napi.darwin-arm64.node",
  "sodium-native.node": "sodium-native/prebuilds/darwin-arm64/sodium-native.node",
  "tree-sitter-python.so": "@ast-grep/lang-python/prebuilds/prebuild-macOS-ARM64/parser.so",
  "tree-sitter-go.so": "@ast-grep/lang-go/prebuilds/prebuild-macOS-ARM64/parser.so",
  "tree-sitter-rust.so": "@ast-grep/lang-rust/prebuilds/prebuild-macOS-ARM64/parser.so",
  "tree-sitter-bash.so": "@ast-grep/lang-bash/prebuilds/prebuild-macOS-ARM64/parser.so",
};

const libraryOf = (path: string): BundleLibrary | null =>
  BUNDLE_LIBRARY_NAMES.find((name) =>
    path.endsWith(`/node_modules/${BUNDLE_LIBRARY_SOURCES[name]}`)
  ) ?? null;

/** JavaScript for the library's path at run time: beside the real executable, in its bundle. */
const runtimePath = (name: BundleLibrary) => {
  const up = BUNDLE_FILES.polaris.split("/").map(() => "..");
  const parts = [...up, ...BUNDLE_FILES[name].split("/")].map((part) => JSON.stringify(part));

  return `require("node:path").join(require("node:fs").realpathSync(process.execPath), ${parts.join(", ")})`;
};

/** An addon is loaded where it was required; any other library is the path its importer opens. */
const moduleFor = (name: BundleLibrary) =>
  name.endsWith(".node")
    ? `module.exports = require(${runtimePath(name)});\n`
    : `module.exports = ${runtimePath(name)};\n`;

export type BundleLibrariesPlugin = BunPlugin & {
  /** The file each library was taken from; a library the build never met is missing here. */
  readonly sources: ReadonlyMap<BundleLibrary, string>;
};

/**
 * Replaces each library's import with its path in the bundle, so the compile embeds none.
 * `sources` then says which files to copy there.
 */
export const bundleLibrariesPlugin = (): BundleLibrariesPlugin => {
  const sources = new Map<BundleLibrary, string>();

  return {
    name: "polaris-bundle-libraries",
    sources,
    setup(build) {
      build.onLoad({ filter: /\.(?:dylib|node|so)$/ }, ({ path }) => {
        const name = libraryOf(path);

        if (name === null) return undefined;
        sources.set(name, path);

        return { contents: moduleFor(name), loader: "js" };
      });
    },
  };
};

/** Copies the libraries the build met into `bundle`; throws when it did not meet every one. */
export const placeBundleLibraries = (
  bundle: string,
  sources: ReadonlyMap<BundleLibrary, string>
): void => {
  const missing = BUNDLE_LIBRARY_NAMES.filter((name) => !sources.has(name));

  if (missing.length > 0) {
    throw new Error(`the Daemon's build did not import ${missing.join(", ")} (ADR 0108)`);
  }

  mkdirSync(join(bundle, BUNDLE_LIBRARY_DIR), { recursive: true });

  for (const [name, source] of sources) copyFileSync(source, join(bundle, BUNDLE_FILES[name]));
};

const MACH_O_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

const CPU_ARM64 = 0x01_00_00_0c;

const CPU_X86_64 = 0x01_00_00_07;

/** Mach-O file types that are loaded into a process: a dylib and a bundle (an addon). */
const LOADABLE: ReadonlySet<number> = new Set([6, 8]);

/**
 * How many native libraries the compiled darwin executable at `path` embeds in its program:
 * each would be written to the temp directory to be loaded. A darwin Daemon has none.
 */
export const embeddedLibraries = (path: string): number => {
  const bytes = readFileSync(path);
  const { start, end } = embeddedProgram(bytes);
  let count = 0;
  let at = bytes.indexOf(MACH_O_64, start);

  while (at !== -1 && at + 16 <= end) {
    const cpu = bytes.readUInt32LE(at + 4);

    if ((cpu === CPU_ARM64 || cpu === CPU_X86_64) && LOADABLE.has(bytes.readUInt32LE(at + 12)))
      count++;
    at = bytes.indexOf(MACH_O_64, at + MACH_O_64.length);
  }

  return count;
};

export type LoadedLibraries = {
  readonly code: number;
  readonly stdout: string;
  /** Every image dyld loaded into the process, the executable included. */
  readonly images: ReadonlyArray<string>;
};

/**
 * Runs `binary` with `args` and lists what dyld loaded into it (`DYLD_PRINT_LIBRARIES`).
 * Only for a build without the hardened runtime, which drops that variable.
 */
export const loadedLibraries = async (
  binary: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {}
): Promise<LoadedLibraries> => {
  const home = mkdtempSync(join(tmpdir(), "polaris-libraries-"));

  try {
    const proc = Bun.spawn([binary, ...args], {
      env: childEnv({
        HOME: home,
        TMPDIR: home,
        PATH: "/usr/bin:/bin",
        ...env,
        DYLD_PRINT_LIBRARIES: "1",
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Children inherit the variable; only this process's lines count.
    const line = new RegExp(String.raw`^dyld\[${proc.pid}\]: <[0-9A-F-]+> (.+)$`, "gm");

    return { code, stdout, images: [...stderr.matchAll(line)].map((match) => match[1]!) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const SYSTEM = ["/usr/lib/", "/System/"];

/**
 * The images that are neither macOS's nor a file of the executable's own bundle: libraries
 * library validation would have to let through. Empty for a darwin Daemon.
 */
export const foreignLibraries = (binary: string, images: ReadonlyArray<string>) => {
  // dyld names images by their real paths.
  const real = realpathSync(binary);
  const bundle = bundleOf(real) ?? dirname(real);
  const own = new Set<string>(BUNDLE_LIBRARY_NAMES.map((name) => join(bundle, BUNDLE_FILES[name])));

  return images.filter(
    (image) => image !== real && !own.has(image) && !SYSTEM.some((dir) => image.startsWith(dir))
  );
};
