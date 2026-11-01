#!/usr/bin/env node
/**
 * Screenshots of Review's queue with its Reviewed group, on fixtures with made-up
 * repositories (`#review/queue-reviewed`, `#review/queue-done`): both themes and every
 * density, then a pull request's right-click menu on its queue row and on the header.
 *
 *   node scripts/reviewQueueScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-review-queue-"));

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
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
  await page.waitForTimeout(500);
};

const shoot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`screens: ${path}`);
};

const open = async (page: Page, scene: string, testId: string) => {
  await page.evaluate(`location.hash = "#review/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId(testId).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1000);
};

const scenes = async (page: Page) => {
  for (const [scene, testId] of [
    ["queue-reviewed", "review-queue-pushed"],
    ["queue-done", "review-queue-done"],
  ] as const) {
    await open(page, scene, testId);

    for (const density of ["calm", "balanced", "compact"]) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);
        await shoot(page, `${scene}-${theme}-${density}`);
      }
    }
  }

  for (const theme of ["dark", "light"]) {
    await open(page, "queue-reviewed", "review-queue-pushed");
    await appearance(page, theme, "balanced");
    await page.locator('[data-testid="review-queue-row"][data-row="PR_84"]').click({
      button: "right",
    });
    await page.getByTestId("pull-menu").waitFor();
    await page.waitForTimeout(350);
    await shoot(page, `queue-menu-${theme}`);
    await page.keyboard.press("Escape");

    await page.getByTestId("pull-review-subject").click({ button: "right" });
    await page.getByTestId("pull-menu").waitFor();
    await page.waitForTimeout(350);
    await shoot(page, `header-menu-${theme}`);
    await page.keyboard.press("Escape");
  }
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });
  await scenes(page);
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
