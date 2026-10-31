#!/usr/bin/env node
/**
 * Screenshots of stacked pull requests on fixtures (DESIGN.md, Review → Stacks): the subject
 * header of layer 2 of 4 (`#review/stacked`) with its stack popover open, in both themes and
 * every density, and the pull list's layer chip (`#pulls/list`).
 *
 *   node scripts/stackScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-stacks-"));

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
    `Promise.all([window.polaris.request("settings.setTheme", { theme: "${theme}" }), window.polaris.request("settings.setDensity", { density: "${density}" })])`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

const shot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`screens: ${path}`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  await page.evaluate(`location.hash = "#review/stacked"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("stack-chip").waitFor();

  for (const density of ["calm", "balanced", "compact"]) {
    for (const theme of ["dark", "light"]) {
      await appearance(page, theme, density);
      await page.mouse.move(1300, 850);
      await page.waitForTimeout(300);
      await shot(page, `header-${theme}-${density}`);
      await page.getByTestId("stack-chip").hover();
      await page.getByTestId("stack-popover").waitFor();
      await page.waitForTimeout(250);
      await shot(page, `popover-${theme}-${density}`);
    }
  }

  // A branch chip's whole name on hover.
  await appearance(page, "dark", "calm");
  await page.mouse.move(1300, 850);
  await page.waitForTimeout(300);
  await page.getByTestId("branch-chip").first().hover();
  await page.waitForTimeout(700);
  await shot(page, "branch-tooltip-dark");

  await page.evaluate(`location.hash = "#pulls/list"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("row-layer").first().waitFor();

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme, "calm");
    await shot(page, `list-${theme}-calm`);
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
