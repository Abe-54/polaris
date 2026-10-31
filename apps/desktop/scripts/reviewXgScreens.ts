#!/usr/bin/env node
/**
 * Screenshots of Review in the new chrome against Paper X-G: findings, asking the Reviewer,
 * Submit review paused on a critical, and the Stack popover, in Moonlit, Midnight and light
 * at 1440×900 and 1280×720 (`#review/xg`, `#review/xg-chat`).
 *
 *   node scripts/reviewXgScreens.ts --out <dir> [--build]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";
import { startDaemon } from "./lib/daemon.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
] as const;

/** Each state: its scene, what to wait for, and what to open first. */
const STATES = [
  { name: "findings", scene: "xg", ready: "risk-finding", open: null, shows: null },
  { name: "chat", scene: "xg-chat", ready: "reviewer-asks", open: null, shows: null },
  {
    name: "critical-pause",
    scene: "xg",
    ready: "submit-review-open",
    open: "submit-review-open",
    shows: "critical-pause",
  },
  { name: "stack", scene: "xg", ready: "stack-chip", open: "stack-chip", shows: "stack-popover" },
] as const;

const home = mkdtempSync("/tmp/pxg-");

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const appearance = async (page: Page, theme: string, dark: string | null) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.evaluate(
    dark === null
      ? `delete document.documentElement.dataset.themeDark`
      : `document.documentElement.dataset.themeDark = "${dark}"`
  );
  await page.waitForTimeout(500);
};

try {
  const page = await app.firstWindow();

  mkdirSync(out, { recursive: true });

  for (const size of SIZES) {
    await page.setViewportSize(size);

    for (const state of STATES) {
      for (const { name, theme, dark } of THEMES) {
        await page.evaluate(`location.hash = "#review/${state.scene}"; location.reload()`);
        await page.waitForLoadState("domcontentloaded");
        await page.getByTestId(state.ready).first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(1200);
        await appearance(page, theme, dark);

        if (state.open !== null) {
          await page.getByTestId(state.open).first().click();
          await page.getByTestId(state.shows).waitFor();
          await page.waitForTimeout(400);
        }

        const path = join(out, `${state.name}-${name}-${size.width}.png`);

        await page.screenshot({ path });
        console.log(`screens: ${path}`);
      }
    }
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
