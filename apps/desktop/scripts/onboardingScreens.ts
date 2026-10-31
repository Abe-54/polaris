#!/usr/bin/env node
/**
 * Screenshots of onboarding from a fresh home: O1 Welcome (Paper 571-1 night,
 * 5OY-1 dawn) and the O2 setup stage (57Q-1) with a single Host, in both
 * themes and every density for O2.
 *
 *   node scripts/onboardingScreens.ts --out <dir> [--build]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("usage: node scripts/onboardingScreens.ts --out <dir> [--build]");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-onboarding-"));

const userHome = join(home, "user-home");

mkdirSync(userHome, { recursive: true });

const daemon = await startDaemon({ home, benchHarness: true, userHome });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: join(home, "user-data"),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const appearance = async (page: Page, theme: "dark" | "light", density: string) => {
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);
  await page.evaluate(`window.polaris.request("settings.setDensity", { density: "${density}" })`);
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

const shoot = async (page: Page, name: string, densities: ReadonlyArray<string>) => {
  for (const theme of ["dark", "light"] as const) {
    for (const density of densities) {
      await appearance(page, theme, density);
      const suffix = density === "calm" ? "" : `-${density}`;

      await page.screenshot({ path: join(out, `${name}-${theme}${suffix}.png`) });
    }
  }

  await appearance(page, "dark", "calm");
  console.log(`screens: ${name}`);
};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page.getByTestId("welcome").waitFor({ timeout: 15_000 });
  // The footer fills in once the local Host reports its Harnesses.
  await page
    .getByTestId("found")
    .filter({ hasText: /Claude Code|No agents/ })
    .waitFor();
  await page.waitForTimeout(500);
  await shoot(page, "o1-welcome", ["calm"]);

  await page.keyboard.press("Enter");
  await page.getByTestId("host-stage").waitFor({ timeout: 15_000 });
  await page.getByText(/ready on Mac Studio/).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await shoot(page, "o2-setup", ["calm", "balanced", "compact"]);

  // Paper 57Q-1 puts the kicker at y 204 and the card at y 318.
  const box = async (selector: string) => (await page.locator(selector).first().boundingBox())?.y;

  console.log(
    `screens: kicker y ${await box('[data-slot="stage-heading"] p')}, card y ${await box('[data-slot="setup-card"]')}`
  );
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
