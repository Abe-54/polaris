#!/usr/bin/env node
/**
 * Screenshots of Settings → Editor → Tab completion on fixtures (`#tab-completion/<scene>`):
 * seven Hosts with a running model server, and no model server anywhere; both themes, every
 * density. Starts its own throwaway Daemon; never touches a running one.
 *
 *   node scripts/tabCompletionScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-tab-completion-"));

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

const scenes = args.includes("--before") ? ["hosts"] : ["hosts", "empty"];

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1100, height: 1400 });
  mkdirSync(out, { recursive: true });

  for (const scene of scenes) {
    await page.evaluate(`location.hash = "#tab-completion/${scene}"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    await page.getByText("Completion placement").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);

    for (const density of ["calm", "balanced", "compact"]) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);
        const path = join(out, `${scene}-${theme}-${density}.png`);

        await page.screenshot({ path, fullPage: true });
        console.log(`screens: ${path}`);
      }
    }
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
