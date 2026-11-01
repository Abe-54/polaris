#!/usr/bin/env node
/**
 * The sidebar's sections against Paper 12, 12b and 13, in both themes: on a real Daemon with
 * bench sessions, right-click → Pin, Reviews folded and open, Dismiss all in the inbox
 * header (and the chip's count after it); on `#constellations/sidebar`, the Space preview.
 *
 *   node scripts/sidebarScreens.ts --out <dir> [--build]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";
import { seedSource } from "./lib/seed.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-sidebar-"));

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

const theme = async (page: Page, name: string) => {
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${name}" })`);
  await page.locator(`html[data-theme="${name}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

const shot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`screens: ${path}`);
};

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });

const row = (page: Page, title: string) =>
  sidebar(page).locator("[data-session-row]", { hasText: title }).first();

/** Right-click a row, screenshot its menu, and close it. */
const menuShot = async (page: Page, title: string, name: string) => {
  await row(page, title).click({ button: "right" });
  await page.getByTestId("session-context-menu").waitFor();
  await page.waitForTimeout(200);
  await shot(page, name);
  await page.keyboard.press("Escape");
};

const chipCount = (page: Page) =>
  page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: /polaris/ })
    .innerText();

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  await page.evaluate(
    seedSource([
      {
        hostKey: "local",
        name: "polaris",
        sessions: [
          { title: "Glossary first pass", state: "idle" },
          { title: "Orchestrator layout prototype", state: "idle" },
          { title: "Reviewer · #212 layout", state: "idle" },
          { title: "Walkthrough · #212 layout", state: "idle" },
          { title: "Spike GPUI review screen", state: "needs-you" },
          { title: "Polaris planning", state: "working" },
        ],
      },
    ])
  );
  await row(page, "Polaris planning").waitFor();
  await row(page, "Spike GPUI review screen").waitFor();
  await page.waitForTimeout(1500);

  for (const name of ["dark", "light"]) {
    await theme(page, name);
    await menuShot(page, "Polaris planning", `menu-${name}`);
  }

  // Pin through the menu: the Daemon commits SessionPinned and the row moves to Pinned.
  await theme(page, "dark");
  await row(page, "Polaris planning").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await sidebar(page).getByText("Pinned", { exact: true }).waitFor();
  await page.waitForTimeout(300);

  const reviews = page.getByTestId("reviews-group");

  for (const name of ["dark", "light"]) {
    await theme(page, name);
    await shot(page, `pinned-reviews-folded-${name}`);
  }

  await reviews.getByRole("button", { name: /Reviews/ }).click();
  await row(page, "Walkthrough · #212 layout").waitFor();

  for (const name of ["dark", "light"]) {
    await theme(page, name);
    await menuShot(page, "Polaris planning", `pinned-reviews-open-menu-${name}`);
  }

  // Dismiss all from the inbox header; the Workspace chip stops counting it.
  await theme(page, "dark");
  const before = await chipCount(page);

  await sidebar(page)
    .getByRole("radio", { name: /Needs you/ })
    .click();
  await page.getByTestId("dismiss-all").waitFor();

  for (const name of ["dark", "light"]) {
    await theme(page, name);
    await shot(page, `inbox-header-${name}`);
  }

  await page.getByTestId("dismiss-all").click();
  await page.waitForTimeout(400);
  const after = await chipCount(page);

  await shot(page, "inbox-dismissed-light");
  console.log(
    `screens: chip before dismiss ${JSON.stringify(before)}, after ${JSON.stringify(after)}`
  );

  // The Space preview, on the Constellation fixtures.
  await page.evaluate(`location.hash = "#constellations/sidebar"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  const lead = page.getByTestId("lead-group").nth(1).locator("[data-session-row]").first();

  await lead.waitFor();

  for (const name of ["dark", "light"]) {
    await theme(page, name);
    await page.mouse.move(700, 850);
    await lead.hover();
    await page.keyboard.press("Space");
    await page.getByTestId("constellation-peek").waitFor();
    await page.waitForTimeout(300);
    await shot(page, `space-preview-${name}`);
    await page.keyboard.press("Space");
    await page.getByTestId("constellation-peek").waitFor({ state: "detached" });
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
