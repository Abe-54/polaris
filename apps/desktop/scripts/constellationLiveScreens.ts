#!/usr/bin/env node
/**
 * The Constellation tab against the real Daemon (not fixtures): seeds a temporary home with a
 * graph in every state, starts the Daemon from source on it, and screenshots the Lead's tab.
 *
 *   node scripts/constellationLiveScreens.ts --out <dir> [--build]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  REPO_ROOT,
} from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-constellation-live-"));

const repo = join(home, "code", "polaris");

mkdirSync(repo, { recursive: true });

spawnSync("git", ["init", "-q", repo]);

// A base commit, so Retry can dispatch B4 again.
spawnSync(
  "git",
  [
    "-c",
    "user.name=Polaris",
    "-c",
    "user.email=polaris@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  ],
  { cwd: repo }
);

// A first run writes the Host's identity; the graph is seeded while no Daemon holds the store.
const first = await startDaemon({ home, benchHarness: true });

await first.stop();

const seeded = spawnSync(
  "bun",
  [join(REPO_ROOT, "apps/daemon/src/engine/constellation.uiFixture.ts"), home, repo],
  { cwd: REPO_ROOT, encoding: "utf8" }
);

if (seeded.status !== 0) throw new Error(`seeding failed: ${seeded.stderr}`);

console.log(`live: seeded ${seeded.stdout.trim()} events`);

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
  await page.waitForTimeout(500);
};

/** B4's setup failed on the real Host feed: the row, its log, then Retry through the Daemon. */
const setupFlow = async (page: Page) => {
  const b4 = page.getByTestId("constellation-tab").locator('[data-task="B4"]');

  console.log(`live: B4 row "${await b4.textContent()}"`);
  await b4.getByRole("button", { name: "Open the log" }).click();
  await page.locator('[data-testid="worktree-setup"][data-status="failed"]').waitFor();

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.screenshot({ path: join(out, `live-setup-log-${theme}.png`) });
  }

  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button").click();
  await b4.getByRole("button", { name: "Retry" }).click();
  await b4
    .getByText("setup failed", { exact: true })
    .waitFor({ state: "detached", timeout: 30_000 });
  await page.waitForTimeout(1_500);
  console.log(`live: B4 after Retry "${await b4.textContent()}"`);
  await page.screenshot({ path: join(out, "live-setup-retried-dark.png") });
};

try {
  const page = await app.firstWindow();

  page.on("pageerror", (error) => console.log(`live: page error: ${error.message}`));
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });
  await page.getByText("Constellations v1 lead").first().click({ timeout: 30_000 });
  await page.getByTestId("constellation-tab").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("constellation-tab")
    .locator('[data-task="B2"]')
    .waitFor({ timeout: 30_000 });

  const glyphs =
    await page.evaluate(`[...document.querySelectorAll('[data-testid="constellation-tab"] [data-task]')].map((row) => {
    const glyph = row.querySelector("[data-glyph]");
    return row.dataset.task + ":" + (glyph ? glyph.dataset.glyph : "none");
  }).join(" ")`);

  console.log(`live: glyphs ${String(glyphs)}`);

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    const path = join(out, `live-${theme}.png`);

    await page.screenshot({ path });
    console.log(`live: ${path}`);
  }

  await setupFlow(page);
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
