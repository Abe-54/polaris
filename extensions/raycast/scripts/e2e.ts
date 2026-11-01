/**
 * The extension end to end as a user gets it: the standalone project installed
 * from npm and built by `ray build`, then the built SDK pairs with a real
 * Daemon, starts a session and answers its approval (ENG-477).
 *
 *   bun scripts/e2e.ts [project dir]   (a temporary directory when omitted)
 * Set POLARIS_SDK_TARBALL to test a packed SDK before publishing it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchDaemon } from "@polaris/sdk/testing";
import { writeStandalone } from "./standalone.ts";

const run = (argv: ReadonlyArray<string>, cwd: string, env: Record<string, string> = {}) => {
  const result = Bun.spawnSync([...argv], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${result.exitCode})`);
};

const given = process.argv[2];

const project = given === undefined ? mkdtempSync("/tmp/pl-raycast-") : resolve(given);

const dist = join(project, "dist");

try {
  writeStandalone(project, process.env["POLARIS_SDK_TARBALL"]);
  run(["npm", "install", "--no-audit", "--no-fund"], project);
  run(["npm", "run", "build"], project);
  run(["node", join(import.meta.dir, "checkShared.mjs"), dist], project);

  const daemon = await launchDaemon();

  try {
    const pairing = await daemon.pair("Raycast E2E", ["read", "approve", "turn", "start"]);
    const workspaceId = await daemon.registerWorkspace();

    run(["node", join(import.meta.dir, "e2eClient.mjs"), dist], project, {
      POLARIS_HOME: daemon.home,
      PAIRING: pairing,
      WORKSPACE_ID: workspaceId,
    });
  } finally {
    await daemon.stop();
  }
} finally {
  if (given === undefined) rmSync(project, { recursive: true, force: true });
}
