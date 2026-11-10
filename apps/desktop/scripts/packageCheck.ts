#!/usr/bin/env node
/**
 * Launches the packaged app (`bun run package` first) against a local Daemon and checks that
 * it calls itself Polaris, finds its Daemon builds and icon, connects, and has its fuses set:
 * it refuses ELECTRON_RUN_AS_NODE, NODE_OPTIONS and --inspect (ENG-878). The app is driven
 * over Chromium's remote debugging port, since the fuses close the Node inspector Playwright's
 * Electron launcher needs.
 *
 *   node scripts/packageCheck.ts [--app <Polaris.app>] [--screenshot <file.png>]
 */
import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import type { PolarisApi } from "../src/shared/api.ts";
import { startDaemon } from "./lib/daemon.ts";
import { APP_DIR, scriptedPackagedApp } from "./lib/electron.ts";
import { fuseMismatches } from "./packaging/fuses.ts";

declare const window: { readonly polaris: PolarisApi };

const args = process.argv.slice(2);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const shot = option("--screenshot");

const bundle = option("--app") ?? join(APP_DIR, "out/dist/Polaris-darwin-arm64/Polaris.app");

const executable = join(bundle, "Contents/MacOS/Polaris");

const resources = join(bundle, "Contents/Resources");

const home = mkdtempSync(join(tmpdir(), "polaris-package-"));

const NODE_OPTIONS_FUSE = "NODE_OPTIONS ignored due to disabled nodeOptions fuse";

let failed = false;

const check = (what: string, ok: boolean, detail: string) => {
  console.log(`package: ${ok ? "ok" : "FAIL"} ${what}: ${detail}`);
  failed ||= !ok;
};

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

const listening = async (port: number) => {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });

    return true;
  } catch {
    return false;
  }
};

const userDataDir = (name: string) => {
  const dir = join(home, name);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ welcomeSeen: true }));

  return dir;
};

interface Launched {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly output: () => string;
}

const launch = (extraArgs: string[], extraEnv: Record<string, string>): Launched => {
  // Node mode reads the first argument as a script and hands it the rest, our flags included.
  const child = scriptedPackagedApp.spawn(executable, [...extraArgs, "--use-mock-keychain"], {
    ...process.env,
    ...extraEnv,
  });

  let output = "";

  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

  return { child, exited, output: () => output };
};

const stop = async (launched: Launched) => {
  if (launched.child.exitCode !== null || launched.child.signalCode !== null) return;

  launched.child.kill("SIGTERM");

  const gone = await Promise.race([
    launched.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);

  if (!gone) launched.child.kill("SIGKILL");
};

/** The app's window over CDP, or null if the process exits or 30 s pass first. */
const appWindow = async (
  launched: Launched,
  port: number
): Promise<{ browser: Browser; page: Page } | null> => {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (launched.child.exitCode !== null) return null;

    if (await listening(port)) {
      const browser = await scriptedPackagedApp.connect(port);
      const page = browser.contexts().flatMap((context) => context.pages())[0];

      if (page !== undefined) return { browser, page };

      await browser.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
};

const waitForLocalHost = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        let lastStatus = "no Host feed items";

        const timer = setTimeout(() => {
          cancel();
          reject(new Error(`local Host did not connect in 30 s: ${lastStatus}`));
        }, 30_000);

        const cancel = window.polaris.subscribe(
          "hosts",
          {},
          {
            items: (items) => {
              lastStatus = JSON.stringify(
                items.flatMap((hosts) =>
                  hosts.map((host) => ({ key: host.key, status: host.status }))
                )
              );

              if (
                !items.some((hosts) =>
                  hosts.some((host) => host.key === "local" && host.status.state === "connected")
                )
              )
                return;

              clearTimeout(timer);
              cancel();
              resolve();
            },
            end: () => {
              clearTimeout(timer);
              cancel();
              reject(new Error("Host feed ended before the local Host connected"));
            },
          }
        );
      })
  );

const plist = (key: string) =>
  spawnSync("plutil", ["-extract", key, "raw", join(bundle, "Contents/Info.plist")])
    .stdout.toString()
    .trim();

const checkBundle = async () => {
  const wrong = await fuseMismatches(bundle);

  check("fuses", wrong.length === 0, wrong.length === 0 ? "as packaged" : wrong.join(", "));
  check("name", plist("CFBundleName") === "Polaris", plist("CFBundleName"));
  check(
    "app.asar only",
    existsSync(join(resources, "app.asar")) && !existsSync(join(resources, "app")),
    "Resources/app.asar"
  );
  check(
    "Daemon builds",
    existsSync(join(resources, "daemon/manifest.json")),
    "Resources/daemon/manifest.json"
  );
  check("window icon", existsSync(join(resources, "icon.png")), "Resources/icon.png");
};

/** Starts the app with NODE_OPTIONS and --inspect; it must connect and run neither. */
const checkAppAndInspector = async (socket: string) => {
  const marker = join(home, "node-options-ran");
  const preload = join(home, "node-options.cjs");
  const cdp = await freePort();
  const inspect = await freePort();

  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);

  const launched = launch(
    [`--inspect=${inspect}`, `--remote-debugging-port=${cdp}`, "--enable-logging=stderr"],
    {
      NODE_OPTIONS: `--require ${preload}`,
      POLARIS_DESKTOP_LOCAL_SOCKET: socket,
      POLARIS_DESKTOP_USER_DATA: userDataDir("user-data"),
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
    }
  );

  try {
    const opened = await appWindow(launched, cdp);

    if (opened === null) throw new Error(`the app did not open a window:\n${launched.output()}`);

    const { browser, page } = opened;

    try {
      const title = await page.title();

      check("window title", title === "Polaris", title);

      await page.waitForFunction(() => Boolean(window.polaris));
      await waitForLocalHost(page);
      check("local Daemon", true, "connected");

      if (shot !== null) await page.screenshot({ path: shot });
    } finally {
      await browser.close();
    }

    // Electron drops --require in any packaged app; only the fuse logs this and drops it all.
    const ran = existsSync(marker);
    const fused = launched.output().includes(NODE_OPTIONS_FUSE);

    check(
      "NODE_OPTIONS refused",
      !ran && fused,
      ran ? "--require ran" : fused ? "ignored by the fuse" : "the fuse did not log it"
    );

    const inspector = await listening(inspect);

    check(
      "--inspect refused",
      !inspector,
      `${inspector ? "an inspector" : "nothing"} on ${inspect}`
    );
  } finally {
    await stop(launched);
  }
};

/** Starts the app with ELECTRON_RUN_AS_NODE: it must open as the app, never run the script. */
const checkRunAsNode = async (socket: string) => {
  const marker = join(home, "run-as-node-ran");
  const cdp = await freePort();
  const script = join(home, "run-as-node.cjs");

  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);

  const launched = launch([script, `--remote-debugging-port=${cdp}`], {
    ELECTRON_RUN_AS_NODE: "1",
    POLARIS_DESKTOP_LOCAL_SOCKET: socket,
    POLARIS_DESKTOP_USER_DATA: userDataDir("user-data-run-as-node"),
  });

  try {
    const opened = await appWindow(launched, cdp);

    await opened?.browser.close();
    check(
      "ELECTRON_RUN_AS_NODE refused",
      opened !== null && !existsSync(marker),
      opened === null ? `no window; ran as Node: ${existsSync(marker)}` : "opened as the app"
    );
  } finally {
    await stop(launched);
  }
};

const daemon = await startDaemon({ home, benchHarness: true, userHome: join(home, "user-home") });

try {
  await checkBundle();
  await checkAppAndInspector(daemon.socketPath);
  await checkRunAsNode(daemon.socketPath);
} catch (error) {
  failed = true;
  console.error("package: FAILED", error);
} finally {
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
