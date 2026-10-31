#!/usr/bin/env node
/**
 * The SQL tab and the Query Log drawer on fixtures (`#data/<scene>`, DESIGN.md Data; Paper D1/D2):
 * results, a database error, completion from the schema, and the Working strip over a table an
 * agent is querying with its Query Log, in both themes and every density.
 *
 *   node scripts/dataSqlScreens.ts --out <dir> [--build] [--show]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { APP_DIR, electronBinary, sizeWindow } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = option("--out");

if (out === null) throw new Error("--out <dir> is required");

mkdirSync(out, { recursive: true });

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-data-sql-"));

const daemon = await startDaemon({ home: join(home, "d"), benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  // A mock Keychain: the screenshots need no secrets, and a background session can't unlock it.
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: args.includes("--show") ? "0" : "1",
  },
});

const log = (m: string) => console.log(`data-sql: ${m}`);

const appearance = async (page: Page, theme: string, density: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

const shoot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(out, `${name}.png`) });
  log(`saved ${name}.png`);
};

const open = async (page: Page, scene: string, testId: string) => {
  await page.evaluate(`location.hash = "#data/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId(testId).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
};

const THEMES = ["dark", "light"] as const;

const DENSITIES = ["calm", "balanced", "compact"] as const;

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);

  for (const theme of THEMES) {
    for (const density of DENSITIES) {
      await appearance(page, theme, density);
      await open(page, "sql", "data-grid");
      await page.mouse.move(1300, 120);
      await shoot(page, `sql-${theme}-${density}`);
      await open(page, "sql-error", "data-sql-error");
      await shoot(page, `sql-error-${theme}-${density}`);
      await open(page, "working", "data-working-strip");
      await page.getByTestId("data-query-log-row").nth(1).hover();
      await shoot(page, `working-${theme}-${density}`);
    }

    await appearance(page, theme, "calm");
    await open(page, "sql", "data-grid");
    const editor = page.locator(".cm-content").first();

    await editor.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type("select i.\nfrom invoices i");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.press("Control+Space");
    await page.locator(".cm-tooltip-autocomplete").waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `completion-${theme}`);
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
