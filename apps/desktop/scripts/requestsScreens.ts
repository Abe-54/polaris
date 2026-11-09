#!/usr/bin/env node
/**
 * Requests (⌘6) on fixtures (`#requests/<scene>`, DESIGN.md Requests) in Moonlit and light: Paper
 * Q1 (a Request with an unsaved edit, just sent) and the list. Needs a built app.
 *
 *   node scripts/requestsScreens.ts <out dir>
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-requests-screens");

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-requests-screens-"));

const app = await electron.launch({
  executablePath: electronBinary(),
  // A mock Keychain: the screenshots need no secrets, and a background session can't unlock it.
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);

  for (const scene of ["q1", "list"] as const) {
    await page.evaluate(`location.hash = "#requests/${scene}"; location.reload()`);
    await page.getByTestId("requests-mode").waitFor({ timeout: 20_000 });

    for (const theme of ["dark", "light"] as const) {
      await page.evaluate(
        `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
      );
      await page.locator(`html[data-theme="${theme}"]`).waitFor();
      await page.mouse.move(1300, 860);
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(out, `requests-${scene}-${theme}.png`) });
      console.log(`requests-screens: saved requests-${scene}-${theme}.png`);
    }
  }

  // ⌘6 on the real shell and command registry, not the preview's.
  await page.evaluate(`location.hash = ""; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Meta+6");
  await page.getByRole("radio", { name: "Requests", checked: true }).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(out, "requests-cmd6.png") });
  console.log("requests-screens: ⌘6 selected the Requests tab on the real shell");
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
