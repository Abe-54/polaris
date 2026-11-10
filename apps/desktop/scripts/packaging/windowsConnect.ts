#!/usr/bin/env node
/**
 * Launches an installed Windows app with This PC on, its Daemon in a throwaway home, and waits
 * for the app to install that Daemon from its own Resources and reach Connected for This PC.
 *
 *   POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL=1 node scripts/packaging/windowsConnect.ts <app-x.y.z\Polaris.exe> <throwaway home> [timeout s]
 *
 * `windows-smoke.ps1` runs it and uninstalls the home afterwards; this script never does.
 */
import { scriptedLocalInstall, scriptedPackagedApp } from "../lib/electron.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
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

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a TCP server listening on a host and port reports an AddressInfo.
      const { port } = server.address() as AddressInfo;

      server.close(() => resolve(port));
    });
  });

const cdp = await freePort();

// The local Host's pipe and installed home, as for the system Daemon but in `home` (daemon.ts).
// The fuses close the inspector `_electron` needs (ENG-878), so the app is driven over CDP.
const child = scriptedPackagedApp.spawn(executable, [`--remote-debugging-port=${cdp}`], {
  ...process.env,
  POLARIS_DESKTOP_USER_DATA: userData,
  POLARIS_DESKTOP_LOCAL_SOCKET: localEndpoint(polarisHome, "win32"),
  ...installEnv,
});

child.stdout.resume();

child.stderr.resume();

/** The app's first window over CDP, once its debugging port answers. */
const firstWindow = async () => {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited with ${child.exitCode}`);

    try {
      await fetch(`http://127.0.0.1:${cdp}/json/version`, { signal: AbortSignal.timeout(2_000) });
      const browser = await scriptedPackagedApp.connect(cdp);
      const page = browser.contexts().flatMap((context) => context.pages())[0];

      if (page !== undefined) return { browser, page };
      await browser.close();
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("no app window over CDP in 60 s");
};

let failed = false;

let browser: Awaited<ReturnType<typeof firstWindow>>["browser"] | null = null;

try {
  const opened = await firstWindow();
  const page = opened.page;
  browser = opened.browser;

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
  await browser?.close();
  child.kill();
}

process.exit(failed ? 1 : 0);
