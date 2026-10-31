#!/usr/bin/env node
/**
 * Review's Traces section and Route timings (ENG-660) on fixtures (`#review/session-traces…`):
 * both themes × every density for each state; Route timings and a Schema Diff take the pane in
 * turn, and an older Daemon shows no section.
 *
 *   node scripts/reviewTracesScreens.ts --out <dir> [--build]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";
import { startDaemon } from "./lib/daemon.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("--out <dir> is required");

mkdirSync(out, { recursive: true });

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

// A short /tmp home: a long path breaks the Daemon's Unix socket.
const home = mkdtempSync(join(tmpdir(), "p8u-"));

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
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(600);
};

const shoot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`traces: ${path}`);
};

const open = async (page: Page, scene: string, testId: string) => {
  await page.evaluate(`location.hash = "#review/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId(testId).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
};

const listEnd = async (page: Page) => {
  await page
    .getByTestId("review-files")
    .locator(".overflow-y-auto")
    .first()
    .evaluate((e: { scrollTop: number; scrollHeight: number }) => {
      e.scrollTop = e.scrollHeight;
    });
  await page.waitForTimeout(300);
  // Then the Traces kicker to the list's top, so the whole section shows.
  await page
    .getByTestId("review-traces-head")
    .first()
    .evaluate((e: { scrollIntoView: (options: { block: string }) => void }) =>
      e.scrollIntoView({ block: "start" })
    );
  await page.waitForTimeout(300);
};

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(what);
  console.log(`traces: ✓ ${what}`);
};

const SCENES = [
  ["session-traces", "traces-compare"],
  ["session-traces-list", "review-traces-head"],
  ["session-traces-new", "traces-compare"],
  ["session-traces-worst", "traces-compare"],
  ["session-traces-failed", "traces-compare"],
  ["session-data-traces", "review-traces-head"],
] as const;

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });

  for (const theme of ["dark", "light"])
    for (const density of ["calm", "balanced", "compact"])
      for (const [scene, testId] of SCENES) {
        await open(page, scene, testId);
        await appearance(page, theme, density);

        // The section sits after the migration and Data: scroll the list to it.
        if (testId === "review-traces-head") await listEnd(page);
        await shoot(page, `${scene}-${theme}-${density}`);
      }

  // The section follows the Data section; Route timings and a Schema Diff take the pane in turn.
  await open(page, "session-data-traces", "review-traces-head");

  const order = String(
    await page.evaluate(
      `[...document.querySelectorAll("[data-testid=review-files] [data-testid^=review-data-head], [data-testid=review-files] [data-testid^=review-traces-head]")].map((e) => e.getAttribute("data-testid")).join(",")`
    )
  );

  check(order.endsWith("review-data-head,review-traces-head"), `traces follow data: ${order}`);
  await page.getByTestId("review-traces-compare").click();
  await page.getByTestId("traces-compare").waitFor();
  check(
    (await page.getByTestId("schema-diff").count()) === 0,
    "Route timings replaces the Schema Diff"
  );
  await page.getByTestId("review-data-schema").first().click();
  await page.getByTestId("schema-diff").waitFor();
  check(
    (await page.getByTestId("traces-compare").count()) === 0,
    "a Schema Diff replaces Route timings"
  );

  await open(page, "session-traces-unsupported", "review-file-row");
  check(
    (await page.getByTestId("review-traces-head").count()) === 0,
    "an older Daemon shows no Traces section"
  );
  await shoot(page, "session-traces-unsupported-dark");
  console.log("traces: OK");
} catch (cause) {
  const page = await app.firstWindow();

  await page.screenshot({ path: join(out, "failed.png") });
  console.log(`traces: FAILED ${String(cause)}`);
  process.exitCode = 1;
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
