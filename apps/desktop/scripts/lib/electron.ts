/** Paths shared by the build, dev, smoke and bench scripts; runs under Bun and Node. */
import { spawn, spawnSync } from "node:child_process";
import type { ElectronApplication } from "playwright-core";
import { _electron, chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devBundleBinary } from "./devBundle.ts";
import { scriptedInstallHome } from "../../src/main/local/scripted.ts";

type LaunchOptions = NonNullable<Parameters<typeof _electron.launch>[0]>;

/** All automated launches opt out of the system Daemon, even when the caller inherits its env. */
export const scriptedLaunchOptions = (options: LaunchOptions): LaunchOptions => ({
  ...options,
  env: { ...(options.env ?? process.env), POLARIS_DESKTOP_SCRIPTED: "1" },
});

/** Dedicated install smokes must request this before starting their fixture or Electron. */
export const scriptedLocalInstall = (home: string, env: NodeJS.ProcessEnv = process.env) => {
  const installedHome = scriptedInstallHome(home, env);

  if (installedHome === null)
    throw new Error("install smoke requires POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL=1");

  return {
    POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL: "1",
    POLARIS_DESKTOP_LOCAL_HOME: installedHome,
    HOME: installedHome,
    POLARIS_HOME: join(installedHome, ".polaris"),
  };
};

/** The only Playwright Electron launcher for scripts; LocalHost enforces the isolation flag. */
export const scriptedElectron = {
  launch: (options: LaunchOptions) => {
    const guarded = scriptedLaunchOptions(options);

    scriptedInstallHome(guarded.env?.POLARIS_DESKTOP_LOCAL_HOME || null, guarded.env ?? {});

    return _electron.launch(guarded);
  },
};

/**
 * A packaged app, whose fuses close the inspector `_electron` needs (ENG-878): spawned with the
 * same opt-out, then driven over Chromium's remote debugging port.
 */
export const scriptedPackagedApp = {
  spawn: (executable: string, args: string[], env: NodeJS.ProcessEnv) =>
    spawn(executable, args, { env: { ...env, POLARIS_DESKTOP_SCRIPTED: "1" } }),
  connect: (port: number) => chromium.connectOverCDP(`http://127.0.0.1:${port}`),
};

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const REPO_ROOT = join(APP_DIR, "../..");

export const OUT_DIR = join(APP_DIR, "out");

/** node_modules' Electron binary; downloads it first if `bun install` skipped its postinstall. */
export const stockElectronBinary = (): string => {
  const require = createRequire(join(APP_DIR, "package.json"));
  const pkgDir = dirname(require.resolve("electron/package.json"));

  if (!existsSync(join(pkgDir, "dist"))) {
    const result = spawnSync("node", [join(pkgDir, "install.js")], { stdio: "inherit" });

    if (result.status !== 0) throw new Error("could not download the Electron binary");
  }

  // SAFETY: electron's main module exports the binary's path as a string.
  return require("electron") as string;
};

/** The dusk icon for the dev bundle, else the standard one. */
const devIcon = () =>
  [
    join(REPO_ROOT, "design/assets/app-icon/dusk/PolarisDev.icns"),
    join(REPO_ROOT, "design/assets/app-icon/Polaris.icns"),
  ].find((path) => existsSync(path)) ?? null;

/**
 * The Electron binary dev and the Playwright scripts launch: on macOS `out/dev/Polaris Dev.app`
 * (scripts/lib/devBundle.ts) unless POLARIS_DESKTOP_STOCK_ELECTRON=1; elsewhere the stock one.
 */
export const electronBinary = (): string => {
  const stock = stockElectronBinary();

  if (process.platform !== "darwin" || process.env.POLARIS_DESKTOP_STOCK_ELECTRON === "1")
    return stock;

  return devBundleBinary({ electron: stock, outDir: join(OUT_DIR, "dev"), icon: devIcon() });
};

/**
 * Sizes the app's window's content, hidden or not. Use it instead of
 * `page.setViewportSize`: that emulation reports devicePixelRatio 1 on a 2x
 * display while xterm's WebGL canvas still sizes itself in real device pixels,
 * so terminal text renders at half size in screenshots (never in the app).
 */
export const sizeWindow = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    },
    { width, height }
  );
