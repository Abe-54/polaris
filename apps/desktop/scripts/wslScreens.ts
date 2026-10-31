#!/usr/bin/env node
/**
 * Settings → Hosts on the `wsl` fixture scene (Paper W1–W3): the WSL Hosts'
 * rows and Needs Attention cards, and "Add a host" with the distros, in both
 * themes. Runs on a Mac; no WSL involved.
 *
 *   node scripts/wslScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-wsl-screens-"));

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

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `Promise.all([window.polaris.request("settings.setTheme", { theme: "${theme}" }), window.polaris.request("settings.setDensity", { density: "calm" })])`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

const shot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path, fullPage: true });
  console.log(`screens: ${path}`);
};

const expectText = async (page: Page, text: string) => {
  await page.getByText(text).first().waitFor({ timeout: 10_000 });
  console.log(`wsl: saw "${text}"`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 1100 });
  mkdirSync(out, { recursive: true });

  for (const theme of ["dark", "light"]) {
    await page.evaluate(`location.hash = "#hosts/wsl"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("keep-daemons-up-to-date").waitFor();
    await appearance(page, theme);
    await expectText(page, "inside WSL on this PC");
    await expectText(page, "WSL didn't start on this PC");
    await expectText(page, "WSL no longer lists a distro called Fedora");
    await shot(page, `hosts-${theme}`);

    await page.getByRole("button", { name: "Add a host" }).click();
    await page.getByTestId("add-wsl").waitFor();
    await expectText(page, "WSL distros on this PC");
    await expectText(page, "WSL 1: convert it with wsl --set-version first");
    await shot(page, `add-${theme}`);

    await page.getByRole("radio", { name: /^Alpine/ }).click();
    await page.getByTestId("wsl-footer").waitFor();
    await expectText(page, "\\\\wsl.localhost\\Alpine");
    await shot(page, `add-picked-${theme}`);
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
