#!/usr/bin/env node
/**
 * The Table tab on fixtures (`#data/<scene>`, DESIGN.md Data; Paper D1/D2): screenshots in both
 * themes and every density, the worst case (60 columns, a 200-char text, a 1 MB JSON value), and
 * the grid's scroll frame rate over 10,000 rows × 20 columns against the display's interval.
 *
 *   node scripts/dataTableScreens.ts --out <dir> [--build] [--bench-only] [--json <path>]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** DESIGN.md Performance: frame p95 within 1.5 display intervals, at most 2% dropped. */
const BUDGET = { frameP95Intervals: 1.5, droppedShare: 0.02, maxIntervalMs: 34 } as const;

const home = mkdtempSync(join(tmpdir(), "polaris-data-table-"));

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

const log = (m: string) => console.log(`data-table: ${m}`);

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

const open = async (page: Page, scene: string, testId = "data-grid") => {
  await page.evaluate(`location.hash = "#data/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId(testId).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
};

const cell = (page: Page, row: number, col: number) =>
  page.locator(`[data-row="${row}"][data-col="${col}"]`).first();

/** Runs `js` in the renderer with `grid` bound to the grid's scroller. */
const onGrid = (page: Page, js: string) =>
  page.evaluate(
    `(() => { const grid = document.querySelector('[data-testid="data-grid"]'); ${js}; })()`
  );

const footer = (page: Page) => page.getByTestId("data-table-footer").innerText();

const THEMES = ["dark", "light"] as const;

const DENSITIES = ["calm", "balanced", "compact"] as const;

const screens = async (page: Page) => {
  for (const theme of THEMES) {
    for (const density of DENSITIES) {
      await appearance(page, theme, density);
      await open(page, "table");
      await cell(page, 4, 1).click();
      await page.mouse.move(1300, 120);
      await shoot(page, `table-${theme}-${density}`);
    }

    await appearance(page, theme, "calm");
    await open(page, "structure", "data-structure");
    await shoot(page, `structure-${theme}`);

    await open(page, "worst");
    await shoot(page, `worst-${theme}`);
    await cell(page, 0, 2).dblclick();
    await page.getByTestId("data-cell-inspector").waitFor();
    await shoot(page, `worst-inspector-${theme}`);
    await page.keyboard.press("Escape");
    await onGrid(page, "grid.scrollLeft = grid.scrollWidth");
    await page.waitForTimeout(200);
    await shoot(page, `worst-right-edge-${theme}`);

    await open(page, "table");
    await page.getByLabel("Filter rows").fill("status = 'overdue' and cu");
    await page.getByTestId("data-filter-completion").first().waitFor();
    await shoot(page, `filter-completion-${theme}`);

    await open(page, "table");
    await page.getByTestId("data-fk").first().click();
    await page.waitForTimeout(600);
    await shoot(page, `foreign-key-${theme}`);

    await open(page, "table");
    await cell(page, 1, 1).click();
    await cell(page, 3, 1).click({ modifiers: ["Shift"] });
    await page.keyboard.press("Meta+L");
    await page.waitForTimeout(500);
    await shoot(page, `add-rows-${theme}`);

    await open(page, "no-rows", "data-table-footer");
    await shoot(page, `no-rows-${theme}`);
    await open(page, "denied", "data-table-failed");
    await shoot(page, `denied-${theme}`);
  }
};

/** Frame gaps (ms) from rAF timestamps while `drive` runs each frame, for `ms`. */
const frames = (page: Page, ms: number, drive: string) =>
  page.evaluate<Array<number>>(`new Promise((resolve) => {
    const grid = document.querySelector('[data-testid="data-grid"]');
    const times = [];
    const end = performance.now() + ${ms};
    const tick = (t) => {
      times.push(t);
      (${drive})(grid, times.length);
      if (t < end) requestAnimationFrame(tick); else resolve(times.slice(1).map((x, i) => x - times[i]));
    };
    requestAnimationFrame(tick);
  })`);

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

const bench = async (page: Page) => {
  await appearance(page, "dark", "calm");
  await open(page, "bench");

  // Page in all 10,000 rows: each scroll to the end asks for the next 1,000.
  for (let i = 0; i < 40 && !(await footer(page)).includes("10,000 rows"); i++) {
    await onGrid(page, "grid.scrollTop = grid.scrollHeight");
    await page.waitForTimeout(250);
  }

  const loaded = await footer(page);

  log(`loaded: ${loaded.split("\n")[0]}`);
  await onGrid(page, "grid.scrollTop = 0");
  await page.waitForTimeout(500);

  const interval = percentile(await frames(page, 1500, "() => {}"), 0.5);

  const runs = {
    // A fast flick: 96 px (3 rows) a frame, top to bottom.
    vertical: await frames(page, 5000, "(grid) => { grid.scrollTop += 96; }"),
    // A jump a frame: 40 rows, as a dragged scrollbar does.
    jumps: await frames(
      page,
      3000,
      "(grid) => { grid.scrollTop = (grid.scrollTop + 1280) % grid.scrollHeight; }"
    ),
    horizontal: await frames(
      page,
      3000,
      "(grid, n) => { grid.scrollLeft = (n * 24) % grid.scrollWidth; }"
    ),
  };

  const columns = await page.locator('[role="columnheader"]').count();
  const heapMb = Number(await page.evaluate("performance.memory.usedJSHeapSize")) / 1_048_576;

  const results = Object.entries(runs).map(([name, gaps]) => {
    const p95 = percentile(gaps, 0.95);
    const dropped = gaps.filter((g) => g > 2 * interval).length / Math.max(1, gaps.length);

    const pass =
      interval <= BUDGET.maxIntervalMs &&
      p95 <= BUDGET.frameP95Intervals * interval &&
      dropped <= BUDGET.droppedShare;

    return {
      name,
      frames: gaps.length,
      p50: percentile(gaps, 0.5),
      p95,
      max: Math.max(...gaps),
      dropped,
      pass,
    };
  });

  log(`display interval ${interval.toFixed(2)} ms (${(1000 / interval).toFixed(0)} Hz)`);
  log(`rendered column headers ${columns} of 20; renderer JS heap ${heapMb.toFixed(0)} MB`);

  for (const r of results)
    log(
      `${r.name}: ${r.frames} frames, p50 ${r.p50.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms, max ${r.max.toFixed(1)} ms, dropped ${(r.dropped * 100).toFixed(2)}% ${r.pass ? "PASS" : "FAIL"}`
    );
  const json = option("--json");

  if (json !== null)
    writeFileSync(json, JSON.stringify({ loaded, interval, heapMb, results }, null, 2));

  return results.every((r) => r.pass);
};

let ok = true;

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);

  if (!args.includes("--bench-only")) await screens(page);
  ok = await bench(page);
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
