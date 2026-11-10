/**
 * A helper app for tests: the real launcher compiled from `launcher.c`, a shell script in
 * agent-desktop's place, and beside it a Daemon bundle whose executable is `daemon`, so the
 * launcher's dev rule (ENG-867) takes that program for the Daemon.
 */
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUNDLE_FILES, DAEMON_BUNDLE } from "../bundle.ts";
import { compileLauncher } from "./build.ts";
import { COMPUTER_USE_BUNDLE, HELPER_FILES, launcherOf } from "./bundle.ts";

const TOOL = `#!/bin/sh
case "$1" in
  echo) cat ;;
  facts) shift; printf '%s\\n' "$@" "$POLARIS_TEST_VAR" "$(pwd)" ;;
  fail) echo oops >&2; exit 7 ;;
  hang) trap 'exit 42' TERM; echo ready; while :; do sleep 0.05; done ;;
  parent) echo $PPID; cat ;;
  stubborn) trap '' TERM; echo $$; while :; do sleep 0.05; done ;;
  big) head -c 300000 /dev/zero | tr '\\0' x ;;
  status) cat "$0.status" ;;
  mark) touch "$2"; echo marked ;;
  fds) ls /dev/fd | tr '\\n' ' ' ;;
esac
`;

/** Where the launcher builds and runs: it is Mach, the Security framework and a private SPI. */
export const launcherRuns = process.platform === "darwin";

/** Ends the name of a suite skipped elsewhere, so a run says why. */
export const MAC_ONLY =
  " [macOS only: the launcher is built with clang on Mach and Security.framework]";

/** The tool's path inside the helper at `helper`. */
export const toolOf = (helper: string) => join(helper, HELPER_FILES["agent-desktop"]);

/** Builds the helper under `root`, serving the program at `daemon`; answers the helper's path. */
export const makeHelper = async (root: string, daemon: string): Promise<string> => {
  const helper = join(root, COMPUTER_USE_BUNDLE);
  const beside = join(root, DAEMON_BUNDLE, BUNDLE_FILES.polaris);
  mkdirSync(dirname(launcherOf(helper)), { recursive: true });
  mkdirSync(dirname(beside), { recursive: true });
  symlinkSync(realpathSync(daemon), beside);
  await compileLauncher(launcherOf(helper));
  writeFileSync(toolOf(helper), TOOL);
  chmodSync(toolOf(helper), 0o755);

  return helper;
};
