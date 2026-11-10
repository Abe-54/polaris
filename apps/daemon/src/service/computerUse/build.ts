/**
 * Builds "Polaris Computer Use.app" (`bundle.ts`) for the Daemon build and the tests: the
 * launcher compiled from `launcher.c`, the capture tool from `capture/`, the tools beside them,
 * and an ad hoc signature. Build time only, on macOS with Xcode's tools; never run on a Host.
 */
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  COMPUTER_USE_BUNDLE,
  COMPUTER_USE_CAPTURE,
  COMPUTER_USE_LAUNCHER,
  HELPER_EXECUTABLES,
  HELPER_FILES,
  type HelperFile,
  helperInfoPlist,
} from "./bundle.ts";

const run = async (argv: ReadonlyArray<string>) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}\n${stderr || stdout}`);
};

/** Compiles the launcher for arm64 with no build paths or times in it, so rebuilds match. */
export const compileLauncher = (outfile: string): Promise<void> =>
  run([
    "/usr/bin/clang",
    "-arch",
    "arm64",
    "-mmacosx-version-min=13.0",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "-o",
    outfile,
    join(import.meta.dir, "launcher.c"),
  ]);

const CAPTURE_SOURCES = join(import.meta.dir, "capture", "Sources", COMPUTER_USE_CAPTURE);

/**
 * Compiles the preview's capture tool (Swift, ScreenCaptureKit) for arm64. Sources go in
 * order with their folder mapped away, so rebuilds match wherever the checkout is.
 */
export const compileCapture = (outfile: string): Promise<void> =>
  run([
    "/usr/bin/xcrun",
    "swiftc",
    "-target",
    "arm64-apple-macos13.0",
    "-swift-version",
    "6",
    "-O",
    "-parse-as-library",
    "-warnings-as-errors",
    "-file-prefix-map",
    `${CAPTURE_SOURCES}=.`,
    "-module-name",
    "polaris_capture",
    "-o",
    outfile,
    ...readdirSync(CAPTURE_SOURCES)
      .filter((name) => name.endsWith(".swift"))
      .toSorted()
      .map((name) => join(CAPTURE_SOURCES, name)),
  ]);

/** The files a build brings to the helper: all but the compiled tools, plist and signature. */
export type HelperInput = Exclude<
  HelperFile,
  | typeof COMPUTER_USE_LAUNCHER
  | typeof COMPUTER_USE_CAPTURE
  | "computer-use-Info.plist"
  | "computer-use-CodeResources"
>;

export interface HelperBuild {
  /** The directory the bundle is made in, beside the Daemon's own. */
  readonly dir: string;
  readonly version: string;
  /** A release build takes the release bundle id; any other takes the dev one. */
  readonly release: boolean;
  readonly inputs: Readonly<Record<HelperInput, string>>;
}

/** Writes and signs the bundle ad hoc; the release signer re-signs it with Developer ID. */
export const buildHelper = async (build: HelperBuild): Promise<string> => {
  const bundle = join(build.dir, COMPUTER_USE_BUNDLE);
  const at = (name: HelperFile) => join(bundle, HELPER_FILES[name]);
  rmSync(bundle, { recursive: true, force: true });

  for (const name of Object.values(HELPER_FILES)) {
    mkdirSync(dirname(join(bundle, name)), { recursive: true });
  }

  await compileLauncher(at(COMPUTER_USE_LAUNCHER));
  await compileCapture(at(COMPUTER_USE_CAPTURE));

  // SAFETY: `inputs` is a Record<HelperInput, string>, so its keys are exactly HelperInput.
  const inputs = Object.keys(build.inputs) as ReadonlyArray<HelperInput>;

  for (const name of inputs) {
    copyFileSync(build.inputs[name], at(name));
    chmodSync(at(name), HELPER_EXECUTABLES.has(name) ? 0o755 : 0o644);
  }

  writeFileSync(at("computer-use-Info.plist"), helperInfoPlist(build.version, build.release));
  await run(["codesign", "--force", "--sign", "-", bundle]);
  await run(["codesign", "--verify", "--deep", "--strict", bundle]);

  return bundle;
};
