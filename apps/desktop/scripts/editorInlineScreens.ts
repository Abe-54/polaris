#!/usr/bin/env node
/**
 * Screenshots of the editor's selection bar, inline card and ⌘L picker on fixtures
 * (`#editor-inline/<scene>`) against Paper E2a (47M-0) and E2 (3AG-0): both themes, every
 * density, and the colourblind palette for the proposal.
 *
 *   node scripts/editorInlineScreens.ts --out <dir> [--build] [--quick]
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

const home = mkdtempSync(join(tmpdir(), "polaris-editor-inline-"));

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
  await page.evaluate(`location.hash = "#editor-inline/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");

  try {
    await page.getByTestId(testId).first().waitFor({ timeout: 20_000 });
  } catch (cause) {
    await shoot(page, `${scene}-failed`);
    throw cause;
  }

  await page.waitForTimeout(600);
};

const SCENES: ReadonlyArray<readonly [string, string]> = [
  ["selection", "selection-bar"],
  ["card", "inline-card"],
  ["thinking", "inline-stop"],
  ["proposed", "inline-accept"],
  ["answer", "inline-answer"],
  ["failed", "inline-notice"],
  ["stale", "inline-notice"],
  ["add", "add-target"],
  ["search", "search-match"],
];

const quick = args.includes("--quick");

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`));
  mkdirSync(out, { recursive: true });

  for (const [scene, testId] of SCENES) {
    await open(page, scene, testId);

    for (const density of quick ? ["balanced"] : ["calm", "balanced", "compact"]) {
      for (const theme of quick ? ["dark"] : ["dark", "light"]) {
        await appearance(page, theme, density);
        await shoot(page, `${scene}-${theme}-${density}`);
      }
    }
  }

  await open(page, "proposed", "inline-accept");
  await appearance(page, "dark", "balanced", "cvd");
  await shoot(page, "proposed-dark-balanced-cvd");
  await appearance(page, "dark", "balanced");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
