#!/usr/bin/env node
/**
 * The break-UI pass (ENG-499): the shell on worst-case fixtures (`#preview/worst*`,
 * features/session/preview/worstScene.ts) in Moonlit, Midnight and light, every density.
 *
 *   node scripts/breakScreens.ts --out <dir> [--build] [--scenes worst,worst-huge] [--sizes 1280x720]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";

const args = process.argv.slice(2);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = option("--out");

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const scenes = (option("--scenes") ?? "worst,worst-machines,worst-empty,worst-huge").split(",");

const densities = (option("--densities") ?? "calm,balanced,compact").split(",");

const sizes = (option("--sizes") ?? "1280x720,1440x900").split(",").map((size) => {
  const [width = 1280, height = 720] = size.split("x").map(Number);

  return { width, height };
});

const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

const themes = (option("--themes") ?? "moonlit,midnight,light").split(",");

const home = mkdtempSync("/tmp/pbk-");

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: join(home, "user-data"),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

try {
  const page = await app.firstWindow();

  mkdirSync(out, { recursive: true });

  for (const scene of scenes) {
    await page.evaluate(`location.hash = "#preview/${scene}"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    await page.locator('aside[aria-label="Sessions"]').first().waitFor({ timeout: 60_000 });

    for (const size of sizes) {
      await page.setViewportSize(size);

      for (const density of densities) {
        for (const { name, theme, dark } of THEMES.filter((t) => themes.includes(t.name))) {
          await page.evaluate(
            `Promise.all([window.polaris.request("settings.setTheme", { theme: "${theme}" }), window.polaris.request("settings.setDensity", { density: "${density}" })])`
          );
          await page.locator(`html[data-theme="${theme}"][data-density="${density}"]`).waitFor({
            state: "attached",
          });
          await page.evaluate(
            dark === null
              ? `delete document.documentElement.dataset.themeDark`
              : `document.documentElement.dataset.themeDark = "${dark}"`
          );
          await page.waitForTimeout(300);
          const path = join(out, `${scene}-${name}-${density}-${size.width}x${size.height}.png`);

          await page.screenshot({ path });
          console.log(`screens: ${path}`);
        }
      }
    }
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
