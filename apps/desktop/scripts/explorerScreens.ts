#!/usr/bin/env node
/**
 * Screenshots of Edit mode's explorer on fixtures (`#explorer/<scene>`) at 1440×900
 * against Paper E1, both themes; `--all-densities` adds Balanced and Compact.
 *
 *   node scripts/explorerScreens.ts --out <dir> [--build] [--scenes files,changes] [--all-densities]
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

const flag = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = flag("--out");

if (out === null) throw new Error("--out <dir> is required");

const ALL = ["files", "changes", "draft", "no-git", "remote", "checkout", "agent"];

const scenes = flag("--scenes")?.split(",") ?? ALL;

const densities = args.includes("--all-densities") ? ["calm", "balanced", "compact"] : ["calm"];

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-explorer-"));

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

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });
  page.on("pageerror", (error) => console.log(`screens: page error: ${error.message}`));

  for (const scene of scenes) {
    await page.evaluate(`location.hash = "#explorer/${scene}"`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("explorer").waitFor();
    await page.waitForTimeout(300);

    for (const density of densities) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);
        const path = join(out, `${scene}-${theme}-${density}.png`);

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
