#!/usr/bin/env node
/**
 * The write approval card and Output's Data tab (Paper D3, ENG-645) on fixtures
 * (`#preview/data-write`, `-worst`, `data-output`): both themes, every density, the colourblind
 * palette and Reduce Motion; a Turn without data has no Data tab.
 *
 *   node scripts/dataWriteScreens.ts --out <dir> [--build]
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

const home = mkdtempSync(join(tmpdir(), "polaris-write-"));

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
  console.log(`write: ${path}`);
};

const open = async (page: Page, scene: string, testId: string) => {
  await page.evaluate(`location.hash = "#preview/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId(testId).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
};

/** Scrolls an element into view; a string, as the script has no DOM types. */
const scrollTo = async (page: Page, testId: string, block: "start" | "end", index = 0) => {
  await page
    .getByTestId(testId)
    .nth(index)
    .evaluate(`(e) => e.scrollIntoView({ block: "${block}" })`);
  await page.waitForTimeout(300);
};

/** The card's top in view: the conversation follows the end, the card is taller than the window. */
const toCard = (page: Page, index = 0) => scrollTo(page, "data-write", "start", index);

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(what);
  console.log(`write: ✓ ${what}`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });

  for (const theme of ["dark", "light"]) {
    await open(page, "data-write", "data-write");
    await appearance(page, theme, "balanced");
    await toCard(page);
    await shoot(page, `write-card-${theme}`);

    await scrollTo(page, "data-write-settled", "start");
    await shoot(page, `write-settled-${theme}`);

    await toCard(page);
    await page.getByTestId("data-write-deny-open").click();
    await page.waitForTimeout(300);
    await scrollTo(page, "data-write-deny", "end");
    await shoot(page, `write-deny-${theme}`);

    await open(page, "data-write-worst", "data-write");
    await appearance(page, theme, "balanced");
    await toCard(page);
    await shoot(page, `write-worst-${theme}`);
    await toCard(page, 1);
    await shoot(page, `write-insert-unpreviewed-${theme}`);

    await open(page, "data-output", "data-output");
    await appearance(page, theme, "balanced");
    await shoot(page, `output-data-${theme}`);
  }

  for (const density of ["calm", "compact"]) {
    await open(page, "data-write", "data-write");
    await appearance(page, "dark", density);
    await toCard(page);
    await shoot(page, `write-card-dark-${density}`);
  }

  await open(page, "data-write", "data-write");
  await appearance(page, "light", "balanced", "cvd");
  await toCard(page);
  await shoot(page, "write-card-light-cvd");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "data-output", "data-output");
  await appearance(page, "dark", "balanced");
  await shoot(page, "output-data-dark-reduce-motion");
  await page.emulateMedia({ reducedMotion: null });

  check(
    (await page.getByTestId("data-output-reads").textContent())?.includes("12 reads") === true,
    "reads fold to one row"
  );
  check((await page.getByTestId("data-output-write").count()) === 1, "the Turn's write is a card");
  check((await page.getByTestId("data-output-schema").count()) === 1, "the schema change shows");

  // Turn 4 touched data too; the session scene's Turn touched none, so it has no Data tab.
  await open(page, "session", "session-output");
  check((await page.getByTestId("output-tab-data").count()) === 0, "no Data tab without data");
  console.log("write: OK");
} catch (cause) {
  const page = await app.firstWindow();

  await page.screenshot({ path: join(out, "failed.png") });
  console.log(`write: FAILED ${String(cause)}`);
  process.exitCode = 1;
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
