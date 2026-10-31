#!/usr/bin/env node
/**
 * Screenshots of Needs You on fixtures (`#needs-you/<scene>`) at the artboards' 1440×900, in
 * both themes and every density: the inbox against Paper 1G2-0, the hover card against 1-0.
 *
 *   node scripts/needsYouScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-needs-you-"));

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

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  for (const scene of ["inbox", "hover", "empty"] as const) {
    await page.evaluate(`location.hash = "#needs-you/${scene}"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    await page
      .getByTestId(
        ({ inbox: "needs-you-inbox", hover: "row-state", empty: "needs-you-empty" } as const)[scene]
      )
      .first()
      .waitFor();

    for (const density of ["calm", "balanced", "compact"]) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);

        if (scene === "hover") {
          await page.mouse.move(0, 0);
          await page.locator('[data-state="needs-you"][role="button"]').first().hover();
          await page.getByTestId("needs-you-hover").waitFor();
          await page.waitForTimeout(250);
        }

        const path = join(out, `${scene}-${theme}-${density}.png`);

        await page.screenshot({ path });
        console.log(`screens: ${path}`);
      }
    }
  }

  // V1 B6: click a waiting Workspace chip, then another session, then open the jump menu.
  await page.evaluate(`location.hash = "#needs-you/hover"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("row-state").first().waitFor();
  await appearance(page, "dark", "calm");
  await page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: /polaris/ })
    .click();
  await page
    .getByRole("button", { name: /Polaris planning/ })
    .first()
    .click();
  await page.mouse.move(1300, 850);
  await page.waitForTimeout(700);
  const stuck = await page.getByTestId("needs-you-hover").count();

  await page.screenshot({ path: join(out, "stuck-dark.png") });
  // The preview has its own navigation, so open the jump menu from the title bar's field.
  await page.getByText("Jump to a session or workspace").first().click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(300);

  const covered = await page.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input');
    if (input === null) return "no input";
    const r = input.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && top.closest('[data-testid="needs-you-hover"]') !== null;
  })()`);

  console.log(
    `screens: layering: hover cards open after leaving: ${stuck}; covering the jump field: ${String(covered)}`
  );
  await page.screenshot({ path: join(out, "layering-dark.png") });
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
