#!/usr/bin/env node
/**
 * Settings → Hosts on `#hosts/task` (ENG-325): Windows installs held by a sign-in task
 * another Polaris home holds, in both themes and every density, then the in-place
 * take-over confirmation and Cancel. Nothing is installed.
 *
 *   node scripts/taskScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-task-"));

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

const shot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`screens: ${path}`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });
  await page.evaluate(`location.hash = "#hosts/task"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByText("Another Polaris home holds the sign-in task on This PC").waitFor();

  for (const density of ["calm", "balanced", "compact"]) {
    for (const theme of ["dark", "light"]) {
      await appearance(page, theme, density);
      await shot(page, `task-${theme}-${density}`);
    }
  }

  const row = page.getByTestId("machine-local");

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme, "calm");
    await row.getByRole("button", { name: "Take over sign-in task" }).click();
    await row.getByTestId("take-over-confirmation").waitFor();
    await shot(page, `confirm-${theme}-calm`);
    await row.getByRole("button", { name: "Cancel" }).click();
    await row.getByTestId("take-over-confirmation").waitFor({ state: "detached" });
  }

  console.log("task: ok");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
