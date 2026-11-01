#!/usr/bin/env bun
/**
 * `polaris` — the Daemon binary. One per user per Host.
 *
 *   polaris serve [--home <dir>]   run the Daemon (normally started by launchd / systemd --user / Task Scheduler)
 *   polaris bridge [--relay <pid>] pipe stdio to the local Daemon socket; what `ssh <host> polaris bridge` runs
 *   polaris install                install this binary and the user service
 *   polaris uninstall [--purge]    remove the user service and binaries (state kept unless --purge)
 *   polaris upgrade <path>         install <path> and hand the running Daemon over to it in place
 *   polaris extension <pair|list|revoke>  pair Extensions with this Host, list and revoke them
 *   polaris version                print the version and platform
 *   polaris selftest               check this build's native libraries work here (exit 1 if not)
 *   polaris tailscale <on|off|status>  Remote Access over Tailscale (ADR 0076)
 *   polaris voice key <set|clear|status>   the voice provider's key in the Host's secure storage
 *   polaris rules-scan             (internal) run the Rules' pattern scan; the Daemon starts it
 *   polaris data-sqlite            (internal) run one SQLite Data read; the Daemon starts it
 */
// Every command loads only what it needs: `bridge` runs once per remote Client for as
// long as it stays connected, and `serve` should not carry the install code.

import { normalizeWindowsEnv } from "./platform/processes.ts";

// Windows names it `Path`: a copy of process.env (`{ ...process.env }`) would have no PATH.
normalizeWindowsEnv();

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "constellation": {
    const { runConstellationStats } = await import("./constellation/stats/cli.ts");
    process.exit(await runConstellationStats(args));
    break;
  }

  case "extension": {
    const { runExtension } = await import("./extensions/cli.ts");
    process.exit(await runExtension(args));
    break;
  }

  case "lease": {
    const { runLease } = await import("./resources/cli.ts");
    process.exit(await runLease(args));
    break;
  }

  case "tailscale": {
    const { runTailscaleCommand } = await import("./remoteAccess/cli.ts");
    process.exit(await runTailscaleCommand(args));
    break;
  }

  case "voice": {
    const { runVoiceCommand } = await import("./voice/cli.ts");
    process.exit(await runVoiceCommand(args));
    break;
  }

  case "serve": {
    const home = args.indexOf("--home");

    // The Windows task passes its Polaris home this way: Task Scheduler sets no environment.
    if (home >= 0 && args[home + 1] !== undefined) {
      const { resolve } = await import("node:path");
      process.env.POLARIS_HOME = resolve(args[home + 1]!);
    }

    const { runServe } = await import("./transport/serve.ts");
    runServe();
    break;
  }

  case "bridge": {
    const { runBridgeCommand } = await import("./transport/bridge.ts");
    process.exit(await runBridgeCommand(args));
    break;
  }

  case "version": {
    const { versionLine } = await import("./service/platform.ts");
    console.log(versionLine());
    break;
  }

  case "selftest": {
    const { selfTest } = await import("./service/selftest.ts");
    const result = await selfTest();
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
    break;
  }

  case "data-sqlite": {
    const { runSqliteChild } = await import("./data/sqlite/child.ts");
    process.exit(await runSqliteChild());
    break;
  }

  case "rules-scan": {
    const { runRulesScan } = await import("./rules/patterns/child.ts");
    process.exit(await runRulesScan());
    break;
  }

  default: {
    const { isServiceCommand, runServiceCommand } = await import("./service/cli.ts");

    if (isServiceCommand(command)) {
      process.exit(await runServiceCommand(command, args));
    }

    console.error(
      `usage: polaris <serve|bridge|install|uninstall|upgrade|version|selftest|lease|constellation|extension|tailscale|voice>`
    );
    process.exit(command === undefined ? 0 : 2);
  }
}
