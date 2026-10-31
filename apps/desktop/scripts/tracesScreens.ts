#!/usr/bin/env node
/**
 * Traces (⌘5) on fixtures (`#traces/<scene>`, DESIGN.md Traces) in Moonlit and light: the mode
 * with traces listed and none open, and with no traces yet. Needs a built app.
 *
 *   node scripts/tracesScreens.ts <out dir>
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

const out = process.argv[2] ?? join(tmpdir(), "polaris-traces-screens");

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-traces-screens-"));

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

  for (const scene of ["traces", "empty"] as const) {
    await page.evaluate(`location.hash = "#traces/${scene}"; location.reload()`);
    await page.getByTestId("traces-mode").waitFor({ timeout: 20_000 });

    for (const theme of ["dark", "light"] as const) {
      await page.evaluate(
        `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
      );
      await page.locator(`html[data-theme="${theme}"]`).waitFor();
      await page.mouse.move(1300, 860);
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(out, `traces-${scene}-${theme}.png`) });
      console.log(`traces-screens: saved traces-${scene}-${theme}.png`);
    }
  }
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
