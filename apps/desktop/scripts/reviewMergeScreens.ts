#!/usr/bin/env node
/**
 * Screenshots of Review's Reviewers and Merge on fixtures with made-up repositories
 * (`#review/merge-…`, `#review/reviewers…`): both themes and every density, then the
 * reviewers search in both themes.
 *
 *   node scripts/reviewMergeScreens.ts --out <dir> [--build] [--only <scene,…>]
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

const valueOf = (flag: string) => {
  const at = args.indexOf(flag);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = valueOf("--out");

if (out === null) throw new Error("--out <dir> is required");

const only = valueOf("--only")?.split(",") ?? null;

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

/** Each scene and the element that says it's drawn. */
const SCENES: ReadonlyArray<readonly [string, string]> = [
  ["merge-header", "merge-open"],
  ["merge-blocked-header", "merge-open"],
  ["merge-ready", "merge-panel"],
  ["merge-blocked", "merge-panel"],
  ["merge-auto", "merge-panel"],
  ["merge-auto-on", "merge-panel"],
  ["merge-kept", "merge-panel"],
  ["merge-done", "review-queue-done"],
  ["reviewers", "reviewers-panel"],
  ["reviewers-empty", "reviewers-panel"],
  ["reviewers-readonly", "reviewers-panel"],
];

const home = mkdtempSync(join(tmpdir(), "polaris-review-merge-"));

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
  for (const [scene, testId] of SCENES) {
    if (only !== null && !only.includes(scene)) continue;
    await open(page, scene, testId);

    for (const density of ["calm", "balanced", "compact"]) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);
        await shoot(page, `${scene}-${theme}-${density}`);
      }
    }
  }

  if (only !== null && !only.includes("reviewers-search")) return;

  for (const theme of ["dark", "light"]) {
    await open(page, "reviewers", "reviewers-panel");
    await appearance(page, theme, "balanced");
    await page.keyboard.type("o");
    await page.getByTestId("reviewer-candidate").first().waitFor();
    await page.waitForTimeout(400);
    await shoot(page, `reviewers-search-${theme}-balanced`);
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
