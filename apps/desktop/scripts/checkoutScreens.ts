#!/usr/bin/env node
/**
 * Screenshots of the Review Checkout chip on fixtures (`#checkout/<scene>`): every state as a
 * sheet against Paper R5 (8B5-0), and its menu against R4 (804-0); both themes, every density,
 * and the colourblind palette for the sheet.
 *
 *   node scripts/checkoutScreens.ts --out <dir> [--build]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const home = mkdtempSync(join(tmpdir(), "polaris-checkout-"));

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const appearance = async (page: Page, theme: string, density: string, palette = "default") => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}", diffPalette: "${palette}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

const shoot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path, fullPage: true });
  console.log(`screens: ${path}`);
};

const open = async (page: Page, scene: string, testId: string) => {
  await page.evaluate(`location.hash = "#checkout/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId(testId).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600);
};

const SCENES: ReadonlyArray<readonly [string, string]> = [
  ["states", "checkout-states"],
  ["menu-new-commits", "checkout-menu"],
  ["menu-running", "checkout-menu"],
  ["menu-failed", "checkout-menu"],
  ["menu-clone", "checkout-menu"],
  ["menu-discard", "checkout-menu"],
];

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  for (const [scene, testId] of SCENES) {
    await open(page, scene, testId);

    for (const density of ["calm", "balanced", "compact"]) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);
        await shoot(page, `${scene}-${theme}-${density}`);
      }
    }
  }

  await open(page, "states", "checkout-states");
  await appearance(page, "dark", "balanced", "cvd");
  await shoot(page, "states-dark-balanced-cvd");
  await appearance(page, "dark", "balanced");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
