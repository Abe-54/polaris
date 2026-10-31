#!/usr/bin/env node
/**
 * Screenshots of Data's sidebar, connection bar and status bar on worst-case fixtures
 * (`#data-sidebar/<scene>`) at 1440×900 against Paper D1/D3: Midnight and light × three densities.
 *
 *   node scripts/dataSidebarScreens.ts --out <dir> [--build] [--scenes worst,card]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { _electron as electron, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const flag = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = flag("--out");

if (out === null) throw new Error("--out <dir> is required");

const ALL = ["worst", "card", "log", "form", "empty", "unreachable", "reconnecting", "offline"];

const scenes = flag("--scenes")?.split(",") ?? ALL;

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-data-sidebar-"));

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  // A mock Keychain: the screenshots need no secrets, and a background session can't unlock it.
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

interface ThemePatch {
  readonly theme: "dark" | "light";
  readonly darkTheme?: "midnight";
}

const THEMES: ReadonlyArray<readonly [string, ThemePatch]> = [
  ["midnight", { theme: "dark", darkTheme: "midnight" }],
  ["light", { theme: "light" }],
];

const appearance = async (page: Page, patch: ThemePatch, density: string) => {
  const full = JSON.stringify({ ...patch, density });

  await page.evaluate(`window.polaris.request("settings.setAppearance", { patch: ${full} })`);
  await page.locator(`html[data-density="${density}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(500);
};

/** The scene's last step, after the appearance settles: the card is a popover a click opens. */
const finish = async (page: Page, scene: string) => {
  if (scene !== "card") return;

  const open = page.locator('[data-testid="data-connection-bar"][data-state="open"]');

  if ((await open.count()) === 0) await page.getByTestId("data-connection-bar").click();
  await page.getByTestId("data-label-field").waitFor();
  await page.mouse.move(1300, 860);
  await page.waitForTimeout(300);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });
  page.on("pageerror", (error) => console.log(`screens: page error: ${error.message}`));

  for (const scene of scenes) {
    await page.evaluate(`location.hash = "#data-sidebar/${scene}"`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("data-mode").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);

    for (const density of ["calm", "balanced", "compact"]) {
      for (const [name, patch] of THEMES) {
        await appearance(page, patch, density);
        await finish(page, scene);
        const path = join(out, `${scene}-${name}-${density}.png`);

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
