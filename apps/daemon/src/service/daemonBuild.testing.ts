/** Real builds of the Daemon by `scripts/build-daemon.ts`, for the slow tests of what a build is. */
import { join } from "node:path";
import { BUNDLE_FILES, DAEMON_BUNDLE } from "./bundle.ts";

const root = join(import.meta.dir, "..", "..", "..", "..");

/** The only darwin platform that ships. */
export const DARWIN_PLATFORM = "darwin-arm64";

/** Whether this machine can build and run that platform's Daemon. */
export const onDarwinArm64 = process.platform === "darwin" && process.arch === "arm64";

/**
 * Whether System Integrity Protection is on. dyld's hardened-runtime checks need it, and
 * GitHub's macOS runners turn it off, so tests of those checks can't run there.
 */
export const sipEnabled =
  process.platform === "darwin" &&
  /status: enabled/.test(Bun.spawnSync(["csrutil", "status"]).stdout.toString());

export type RunResult = { readonly stdout: string; readonly stderr: string; readonly code: number };

export const runIn = async (
  cwd: string,
  argv: ReadonlyArray<string>,
  env: Record<string, string | undefined> = process.env
): Promise<RunResult> => {
  const proc = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, code };
};

/** Builds the Daemon into `dir/name` with `flags`, and gives its bundle. */
export const buildDaemon = async (dir: string, name: string, flags: ReadonlyArray<string>) => {
  const out = join(dir, name);

  const built = await runIn(dir, [
    process.execPath,
    join(root, "scripts", "build-daemon.ts"),
    ...flags,
    `--out=${out}`,
    DARWIN_PLATFORM,
  ]);

  if (built.code !== 0) throw new Error(`the ${name} build failed:\n${built.stderr}`);

  return join(out, DARWIN_PLATFORM, DAEMON_BUNDLE);
};

export const binaryOf = (bundle: string) => join(bundle, BUNDLE_FILES.polaris);

/** The release signer's entitlements for the Daemon: what a release is signed with. */
export const RELEASE_ENTITLEMENTS = join(
  root,
  "apps/desktop/scripts/packaging/entitlements/daemon.plist"
);

/** Signs a copy ad hoc as a release is signed: hardened runtime and the release entitlements. */
export const signHardened = (dir: string, bundle: string) =>
  runIn(dir, [
    "codesign",
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--entitlements",
    RELEASE_ENTITLEMENTS,
    bundle,
  ]);
