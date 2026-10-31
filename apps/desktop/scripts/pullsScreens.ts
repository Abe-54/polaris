#!/usr/bin/env node
/**
 * Screenshots of the pull request list on fixtures (`#pulls/<scene>`) at the artboard's
 * 1440×900, in both themes and every density, against Paper R3 (7LH-0); and Needs You's
 * Reviews group.
 *
 *   node scripts/pullsScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-pulls-"));

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

const SCENES = {
  list: "pulls-group-requested",
  "signed-out": "pulls-signed-out",
  empty: "pulls-empty",
  reviews: "needs-you-reviews",
} as const;

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  for (const [scene, testId] of Object.entries(SCENES)) {
    await page.evaluate(`location.hash = "#pulls/${scene}"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId(testId).first().waitFor();

    const densities = scene === "list" ? ["calm", "balanced", "compact"] : ["calm"];

    for (const density of densities) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);

        const path = join(out, `${scene}-${theme}-${density}.png`);

        await page.screenshot({ path });
        console.log(`screens: ${path}`);
      }
    }
  }

  // Hover the first row and open "Review a PR by URL" with a bad URL, in dark.
  await page.evaluate(`location.hash = "#pulls/list"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("pull-row").first().waitFor();
  await appearance(page, "dark", "calm");
  await page.getByTestId("pull-row").first().hover();
  await page.getByTestId("review-by-url").click();
  await page.getByTestId("review-by-url-input").fill("https://gitlab.com/x/y/merge_requests/1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, "by-url-dark.png") });
  console.log(`screens: ${join(out, "by-url-dark.png")}`);
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
