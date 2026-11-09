#!/usr/bin/env node
/**
 * Requests' send log and states (`#requests/<scene>`, DESIGN.md Requests → States) in Moonlit
 * and light: Paper Q2 and Q3, an agent's Send waiting on an Origin Approval, the empty checkout
 * and an offline Host. Needs a built app.
 *
 *   node scripts/requestsStatesScreens.ts <out dir>
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

const out = process.argv[2] ?? join(tmpdir(), "polaris-requests-states-screens");

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-requests-states-"));

/** Each scene and what shows once it has drawn. */
const SCENES = [
  ["q2", "requests-send-log"],
  ["approval", "origin-approval"],
  ["empty", "requests-empty-checkout"],
  ["offline", "requests-host-offline"],
  ["states", "origin-approval"],
] as const;

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

  for (const [scene, shown] of SCENES) {
    await page.evaluate(`location.hash = "#requests/${scene}"; location.reload()`);
    await page.getByTestId(shown).first().waitFor({ timeout: 20_000 });

    for (const theme of ["dark", "light"] as const) {
      await page.evaluate(
        `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
      );
      await page.locator(`html[data-theme="${theme}"]`).waitFor();
      await page.mouse.move(1300, 860);
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(out, `requests-${scene}-${theme}.png`) });
      console.log(`requests-states-screens: saved requests-${scene}-${theme}.png`);
    }
  }
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
