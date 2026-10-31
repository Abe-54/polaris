#!/usr/bin/env node
/**
 * Review's Data section and Schema Diff (Paper D4, ENG-645) on fixtures (`#review/session-data…`):
 * both themes, every density, the colourblind palette; a migration's "Schema diff" link
 * opens the body, and an older Daemon shows no section.
 *
 *   node scripts/reviewSchemaScreens.ts --out <dir> [--build]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { _electron as electron, type Page } from "playwright-core";
import { APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";
import { startDaemon } from "./lib/daemon.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("--out <dir> is required");

mkdirSync(out, { recursive: true });

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-schema-"));

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

const appearance = async (page: Page, theme: string, density: string, palette = "default") => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}", diffPalette: "${palette}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(600);
};

const shoot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`schema: ${path}`);
};

const open = async (page: Page, scene: string, testId: string) => {
  await page.evaluate(`location.hash = "#review/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId(testId).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
};

const SCENES = [
  ["session-data", "schema-diff"],
  ["session-data-worst", "schema-diff"],
  ["session-data-pending", "schema-pending"],
  ["session-data-unavailable", "schema-diff"],
  ["session-data-pruned", "review-data-note"],
] as const;

/** Opens a source of `-worst` by its Data kicker's name. */
const worstSource = async (page: Page, name: string) => {
  const head = page.getByTestId("review-data-head").filter({ hasText: `Data · ${name}` });
  await head.waitFor();
  const heads = await page.getByTestId("review-data-head").allTextContents();
  const index = heads.indexOf(`Data · ${name}`);

  await page.getByTestId("review-data-schema").nth(index).click();
  await page.getByTestId("schema-diff").waitFor();
  await page.waitForTimeout(300);
};

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(what);
  console.log(`schema: ✓ ${what}`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });

  for (const theme of ["dark", "light"]) {
    for (const [scene, testId] of SCENES) {
      await open(page, scene, testId);
      await appearance(page, theme, "balanced");
      await shoot(page, `${scene}-${theme}`);
    }

    await open(page, "session-data-diff", "review-schema-link");
    await appearance(page, theme, "balanced");
    await shoot(page, `session-data-diff-${theme}`);

    // -worst's other sources: a carried baseline, a wide table with folds, real failures.
    await open(page, "session-data-worst", "schema-diff");
    await appearance(page, theme, "balanced");

    for (const name of ["staging", "warehouse", "billing", "legacy"]) {
      await worstSource(page, name);
      await shoot(page, `session-data-worst-${name}-${theme}`);
    }

    await worstSource(page, "ledger");

    const show = page.getByRole("button", { name: /Show definition/ });

    while ((await show.count()) > 0) await show.first().click();
    await shoot(page, `session-data-worst-ledger-${theme}`);
  }

  for (const density of ["calm", "compact"]) {
    await open(page, "session-data", "schema-diff");
    await appearance(page, "dark", density);
    await shoot(page, `session-data-dark-${density}`);
  }

  await open(page, "session-data", "schema-diff");
  await appearance(page, "light", "balanced", "cvd");
  await shoot(page, "session-data-light-cvd");
  await appearance(page, "dark", "balanced");

  // The data rows sit right after the migration file in the files list.
  const order = String(
    await page.evaluate(
      `[...document.querySelectorAll("[data-testid=review-files] [data-path], [data-testid=review-files] [data-testid^=review-data]")].map((e) => e.getAttribute("data-path") ?? e.getAttribute("data-testid")).join("\\n")`
    )
  ).split("\n");

  const migration = order.findIndex((p) => p.includes("prisma/migrations/"));

  check(
    order[migration + 1] === "review-data-head",
    `data follows the migration: ${order.join(", ")}`
  );

  // A migration's header link opens the body; opening a file returns to the diff.
  await open(page, "session-data-diff", "review-schema-link");
  await page.getByTestId("review-schema-link").first().click();
  await page.getByTestId("schema-diff").waitFor();
  check(true, "the migration's Schema diff link opens the body");
  await page.locator("[data-testid=review-file-row] button").first().click();
  await page.getByTestId("schema-diff").waitFor({ state: "detached" });
  check(true, "opening a file returns to the diff");

  await open(page, "session-data-unsupported", "review-file-row");
  check(
    (await page.getByTestId("review-data-schema").count()) === 0,
    "an older Daemon shows no Data section"
  );
  await shoot(page, "session-data-unsupported-dark");
  console.log("schema: OK");
} catch (cause) {
  const page = await app.firstWindow();

  await page.screenshot({ path: join(out, "failed.png") });
  console.log(`schema: FAILED ${String(cause)}`);
  process.exitCode = 1;
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
