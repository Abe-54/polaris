#!/usr/bin/env node
/**
 * Settings → Sessions' Suggested replies card (ENG-887), off and on, dark and light, against a
 * throwaway local Daemon. Nothing is installed.
 *
 *   node scripts/suggestedRepliesScreens.ts --out <dir> [--build]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

// A short path: the Daemon's Unix socket lives under it.
const home = mkdtempSync("/tmp/pgr-");

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const look = async (page: Page, theme: "dark" | "light") => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 1100 });
  mkdirSync(out, { recursive: true });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings.open")?.click();
  });
  const settings = page.getByTestId("settings");

  await settings.waitFor({ timeout: 5_000 });
  await settings.getByRole("button", { name: "Sessions", exact: true }).click();

  const card = page.locator("section", {
    has: page.getByRole("heading", { name: /^Suggested replies/ }),
  });

  const toggle = card.getByRole("switch", { name: "Suggest replies" });

  await card.waitFor();

  for (const state of ["off", "on"] as const) {
    if ((await toggle.getAttribute("aria-checked")) !== String(state === "on"))
      await toggle.click();

    for (const theme of ["dark", "light"] as const) {
      await look(page, theme);
      await card.scrollIntoViewIfNeeded();
      await page.mouse.move(1430, 1090);
      await page.waitForTimeout(400);
      const path = join(out, `suggested-replies-${state}-${theme}.png`);

      await card.screenshot({ path });
      console.log(`screens: ${path}`);
    }
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
