#!/usr/bin/env node
/**
 * Launches an installed Windows app with This PC on, its Daemon in a throwaway home, and waits
 * for the app to install that Daemon from its own Resources and reach Connected for This PC.
 *
 *   POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL=1 node scripts/packaging/windowsConnect.ts <app-x.y.z\Polaris.exe> <throwaway home> [timeout s]
 *
 * `windows-smoke.ps1` runs it and uninstalls the home afterwards; this script never does.
 */
import { scriptedElectron as electron, scriptedLocalInstall } from "../lib/electron.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localEndpoint } from "@polaris/protocol/endpoint";
import type { PolarisApi } from "../../src/shared/api.ts";

declare const window: { readonly polaris: PolarisApi };

const [executable, home, timeoutArg] = process.argv.slice(2);

if (executable === undefined || home === undefined) {
  console.error("usage: node windowsConnect.ts <Polaris.exe> <throwaway home> [timeout s]");
  process.exit(2);
}

const timeoutMs = Number(timeoutArg ?? "120") * 1000;

const installEnv = scriptedLocalInstall(home);

const polarisHome = join(installEnv.POLARIS_DESKTOP_LOCAL_HOME, ".polaris");

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ local: { enabled: true }, automaticAppUpdates: false, welcomeSeen: true })
);

// The local Host's pipe and installed home, as for the system Daemon but in `home` (daemon.ts).
const app = await electron.launch({
  executablePath: executable,
  env: {
    ...process.env,
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_LOCAL_SOCKET: localEndpoint(polarisHome, "win32"),
    ...installEnv,
  },
});

let failed = false;

try {
  const page = await app.firstWindow();

  page.on("console", (message) => {
    if (message.text().startsWith("windows-connect:")) console.log(message.text());
  });
  await page.waitForFunction(() => Boolean(window.polaris));

  const reached = await page.evaluate(
    (ms) =>
      new Promise<string>((resolve, reject) => {
        let last = "no machines feed items";

        const timer = setTimeout(() => {
          cancel();
          reject(new Error(`This PC did not connect in ${ms / 1000} s; last: ${last}`));
        }, ms);

        const cancel = window.polaris.subscribe(
          "machines",
          {},
          {
            items: (items) => {
              const local = items.flat().find((machine) => machine.key === "local");
              const now = JSON.stringify({ status: local?.status, install: local?.install });

              if (now !== last) console.log(`windows-connect: ${now}`);
              last = now;

              if (local?.status?.state !== "connected") return;
              clearTimeout(timer);
              cancel();
              resolve(local.label);
            },
            end: () => {
              clearTimeout(timer);
              reject(new Error(`the machines feed ended first; last: ${last}`));
            },
          }
        );
      }),
    timeoutMs
  );

  const installed = join(polarisHome, "bin", "current", "polaris.exe");

  if (!existsSync(installed))
    throw new Error(`connected, but nothing is installed at ${installed}`);
  console.log(`APP CONNECTED: ${reached} on ${localEndpoint(polarisHome, "win32")} (${installed})`);
} catch (error) {
  failed = true;
  console.error("windows-connect: FAILED", error);
} finally {
  await app.close();
}

process.exit(failed ? 1 : 0);
