#!/usr/bin/env node
/**
 * Screenshots of Data's sidebar, connection bar and status bar on worst-case fixtures
 * (`#data-sidebar/<scene>`) at 1440×900 against Paper D1/D3: Midnight and light × three densities.
 *
 *   node scripts/dataSidebarScreens.ts --out <dir> [--build] [--scenes worst,card] [--densities balanced]
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

const densities = flag("--densities")?.split(",") ?? ["calm", "balanced", "compact"];

/** The scenes shot at the 760×600 minimum window instead of 1440×900. */
const NARROW = new Set(["narrow"]);

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

const openCard = async (page: Page) => {
  const open = page.locator('[data-testid="data-connection-bar"][data-state="open"]');

  if ((await open.count()) === 0) await page.getByTestId("data-connection-bar").click();
  await page.getByTestId("data-label-field").waitFor();
};

const keys = async (page: Page) => {
  if ((await page.locator("[data-tree-key]:focus").count()) > 0) return;
  await page.locator('[data-tree-key][tabindex="0"]').focus();

  for (const key of ["Home", "ArrowDown", "ArrowDown", "ArrowDown"]) await page.keyboard.press(key);
};

const removing = async (page: Page) => {
  await openCard(page);

  if ((await page.getByTestId("data-source-remove-confirm").count()) === 0)
    await page.getByTestId("data-source-remove").click();
};

const clearing = async (page: Page) => {
  const clear = page.getByTestId("data-source-clear-password");

  if ((await clear.getAttribute("aria-pressed")) !== "true") await clear.click();
};

const naming = async (page: Page) => {
  const form = page.getByTestId("data-source-form");

  if ((await form.getByRole("alert").count()) > 0) return;
  await form.locator("input").first().fill("Billing DB");
  await form.getByRole("button", { name: "Add data source" }).click();
};

/** Each scene's last steps, after the appearance settles; each one is safe to run again. */
const STEPS = new Map([
  ["card", openCard],
  ["manual", removing],
  ["edit", clearing],
  ["name", naming],
  ["keys", keys],
]);

const finish = async (page: Page, scene: string) => {
  await STEPS.get(scene)?.(page);
  await page.mouse.move(NARROW.has(scene) ? 740 : 1300, NARROW.has(scene) ? 580 : 860);
  await page.waitForTimeout(300);
};

try {
  const page = await app.firstWindow();

  mkdirSync(out, { recursive: true });
  page.on("pageerror", (error) => console.log(`screens: page error: ${error.message}`));

  for (const scene of scenes) {
    await page.setViewportSize(
      NARROW.has(scene) ? { width: 760, height: 600 } : { width: 1440, height: 900 }
    );
    await page.evaluate(`location.hash = "#data-sidebar/${scene}"`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("data-mode").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);

    for (const density of densities) {
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
