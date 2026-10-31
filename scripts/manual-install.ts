#!/usr/bin/env bun
/**
 * Manual end-to-end check of `polaris install` / `uninstall` on this machine.
 * It registers a real LaunchAgent (or systemd --user unit) and starts it, so
 * it refuses to run unless you opt in:
 *
 *   POLARIS_MANUAL_INSTALL=1 bun scripts/manual-install.ts [--uninstall]
 *
 * Builds the Daemon for this platform, installs it under ~/.polaris (or
 * $POLARIS_HOME), prints the report, runs install again to show it is
 * idempotent, and with --uninstall removes it again. Never run by CI or tests.
 */
import { join } from "node:path";
import { BUNDLE_FILES, DAEMON_BUNDLE } from "../apps/daemon/src/service/bundle.ts";

if (process.env.POLARIS_MANUAL_INSTALL !== "1") {
  console.error(
    "Refusing: this installs a real user service. Set POLARIS_MANUAL_INSTALL=1 to run it."
  );
  process.exit(2);
}

const root = join(import.meta.dir, "..");

const platform = `${process.platform}-${process.arch}`;

// macOS builds the Daemon into its app bundle (ENG-680).
const binary = join(
  root,
  "apps",
  "daemon",
  "dist",
  platform,
  process.platform === "darwin" ? join(DAEMON_BUNDLE, BUNDLE_FILES.polaris) : "polaris"
);

const step = (argv: ReadonlyArray<string>) => {
  console.log(`$ ${argv.join(" ")}`);
  const result = Bun.spawnSync([...argv], { stdout: "inherit", stderr: "inherit" });

  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
};

step([process.execPath, join(import.meta.dir, "build-daemon.ts"), platform]);

step([binary, "install"]);

step([binary, "install"]); // idempotent: nothing changes, nothing restarts

if (process.argv.includes("--uninstall")) step([binary, "uninstall"]);
