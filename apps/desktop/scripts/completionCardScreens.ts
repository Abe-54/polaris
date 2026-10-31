#!/usr/bin/env node
/**
 * Screenshots of the status bar's tab completion card on fixtures (`#completion-card/<scene>`):
 * every state side by side, then the real status item with its card opened by click, in both
 * themes, every density, and once with Reduce Motion. Starts its own throwaway Daemon.
 *
 *   node scripts/completionCardScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-completion-card-"));

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
  await page.waitForTimeout(300);
};

const load = async (page: Page, scene: string) => {
  await page.evaluate(`location.hash = "#completion-card/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
};

// The Model fact's note ("next edit · recommended") must fit the card whole (Paper EP8).
const modelNoteFits = async (page: Page, where: string) => {
  const clipped =
    await page.evaluate(`[...document.querySelectorAll('[data-fact="Model"] > :last-child')]
    .filter((note) => note.scrollWidth > note.clientWidth)
    .map((note) => note.closest("[data-scene]")?.getAttribute("data-scene") + " (" + note.clientWidth + " of " + note.scrollWidth + "px)")`);

  if (!Array.isArray(clipped)) throw new Error("screens: the Model fact check returned no list");

  if (clipped.length > 0)
    throw new Error(`screens: ${where}: the Model fact's note is cut off in ${clipped.join(", ")}`);
};

try {
  const page = await app.firstWindow();

  mkdirSync(out, { recursive: true });

  await page.setViewportSize({ width: 1640, height: 1500 });
  await load(page, "states");
  await page.locator("[data-scene]").first().waitFor({ timeout: 20_000 });

  for (const density of ["calm", "balanced", "compact"])
    for (const theme of ["dark", "light"]) {
      await appearance(page, theme, density);
      await modelNoteFits(page, `${theme} ${density}`);
      const path = join(out, `states-${theme}-${density}.png`);
      await page.screenshot({ path, fullPage: true });
      console.log(`screens: ${path}`);
      const card = join(out, `managed-serving-${theme}-${density}.png`);
      await page.locator('[data-scene="managed-serving"]').screenshot({ path: card });
      console.log(`screens: ${card}`);
    }

  await page.setViewportSize({ width: 900, height: 620 });
  await load(page, "bar");
  const status = page.getByTestId("prediction-status");
  await status.waitFor({ timeout: 20_000 });

  for (const density of ["calm", "balanced", "compact"])
    for (const theme of ["dark", "light"]) {
      await appearance(page, theme, density);
      await page.mouse.move(10, 10);
      await status.click();
      await page.getByTestId("completion-card").waitFor();
      await page.waitForTimeout(500);
      const focused = await page.evaluate("document.activeElement?.textContent ?? null");
      console.log(`screens: focus after click is on ${String(focused)}`);
      const path = join(out, `bar-${theme}-${density}.png`);
      await page.screenshot({ path });
      console.log(`screens: ${path}`);
      await page.keyboard.press("Escape");
      await page.getByTestId("completion-card").waitFor({ state: "detached" });
    }

  // Focus alone (Tab onto the item) opens it too, with focus left on the item.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await appearance(page, "dark", "balanced");
  await page.mouse.move(10, 10);
  await status.blur();
  await page.waitForTimeout(300);
  await status.focus();
  await page.getByTestId("completion-card").waitFor();
  await page.waitForTimeout(300);
  const focused = join(out, "bar-focus-reduced-motion.png");
  await page.screenshot({ path: focused });
  console.log(`screens: ${focused}`);
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
