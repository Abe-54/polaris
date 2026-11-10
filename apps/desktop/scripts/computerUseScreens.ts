#!/usr/bin/env node
/**
 * Screenshots of computer use's cards on fixtures (`#computer-use/<scene>`, Paper CU1–CU3):
 * `states` in both themes and every density, and `onboarding` walked from blank to ready.
 * Starts its own throwaway Daemon; never touches a running one.
 *
 *   node scripts/computerUseScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-cu-"));

const daemon = await startDaemon({ home, benchHarness: false });

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

const appearance = async (page: Page, theme: string, density: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

const open = async (page: Page, scene: string) => {
  await page.evaluate(`location.hash = "#computer-use/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("computer-use-preview").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
};

const shot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path, fullPage: true });
  console.log(`screens: ${path}`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 1000 });
  mkdirSync(out, { recursive: true });

  await open(page, "states");

  for (const density of ["calm", "balanced", "compact"])
    for (const theme of ["dark", "light"]) {
      await appearance(page, theme, density);
      await shot(page, `states-${theme}-${density}`);
    }

  await appearance(page, "dark", "balanced");
  await open(page, "onboarding");
  await shot(page, "onboarding-1-off");
  await page.getByTestId("computer-use-onboarding").getByText("Open System Settings").click();
  await page.waitForTimeout(400);
  await shot(page, "onboarding-2-opened");
  await page.getByText("Allow Screen Recording").first().waitFor({ timeout: 5000 });
  await shot(page, "onboarding-3-screen-recording");
  await page.getByTestId("computer-use-onboarding").getByText("Open System Settings").click();
  await page.getByText("Computer use is ready on Mac Studio").waitFor({ timeout: 5000 });
  await shot(page, "onboarding-4-ready");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
