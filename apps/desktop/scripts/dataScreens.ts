#!/usr/bin/env node
/**
 * Screenshots of Data mode (⌘4) on a seeded agent session in Moonlit and light (DESIGN.md, Data).
 * Needs a built app.
 *
 *   node scripts/dataScreens.ts <out dir>
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { seedSource } from "./lib/seed.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-data-screens");

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-data-screens-"));

const daemon = await startDaemon({ home: join(home, "local"), benchHarness: true });

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", welcomeSeen: true })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  // A mock Keychain: the screenshots need no secrets, and a background session can't unlock it.
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    seedSource([
      {
        hostKey: "local",
        name: "ledger",
        sessions: [{ title: "Fix overdue totals", state: "idle" }],
      },
    ])
  );
  await page.locator('[data-slot="chip"]', { hasText: "ledger" }).first().click();
  await page.getByText("Fix overdue totals", { exact: true }).first().click();
  await page.keyboard.press("Meta+4");
  await page.getByTestId("data-mode").waitFor({ timeout: 10_000 });

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(
      `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
    );
    await page.mouse.move(1300, 860);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `data-empty-${theme}.png`) });
    console.log(`data-screens: saved data-empty-${theme}.png`);
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
