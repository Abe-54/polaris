#!/usr/bin/env node
/**
 * Traces' sidebar, trace bar, waterfall and Table on fixtures (`#traces/<scene>`, DESIGN.md
 * Traces) in Moonlit, Midnight and light at every density, then the 10,000-span trace
 * (`#traces/large`) opened and scrolled, with frame times. Needs a built app.
 *
 *   node scripts/tracesWaterfallScreens.ts <out dir> [--perf-only]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-traces-waterfall");

const perfOnly = process.argv.includes("--perf-only");

const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

const DENSITIES = ["calm", "balanced", "compact"] as const;

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-traces-waterfall-"));

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const open = async (page: Page, scene: string) => {
  await page.evaluate(`location.hash = "#traces/${scene}"; location.reload()`);
  await page.getByTestId("traces-mode").waitFor({ timeout: 20_000 });
};

const appearance = async (
  page: Page,
  { theme, dark }: (typeof THEMES)[number],
  density: string
) => {
  await page.evaluate(
    `Promise.all([window.polaris.request("settings.setTheme", { theme: "${theme}" }), window.polaris.request("settings.setDensity", { density: "${density}" })])`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.evaluate(
    dark === null
      ? `delete document.documentElement.dataset.themeDark`
      : `document.documentElement.dataset.themeDark = "${dark}"`
  );
  await page.waitForTimeout(300);
};

const openTrace = async (page: Page, root: string) => {
  await page.getByTestId("traces-row").filter({ hasText: root }).first().click();
  await page.getByTestId("waterfall-rows").waitFor();
};

const shoot = async (page: Page, name: string, { hover = false } = {}) => {
  if (!hover) await page.mouse.move(1430, 890);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`traces-waterfall: saved ${name}.png`);
};

const screens = async (page: Page) => {
  await open(page, "traces");

  for (const look of THEMES)
    for (const density of DENSITIES) {
      await appearance(page, look, density);
      await openTrace(page, "POST /invoices/overdue");
      await page.getByTestId("waterfall-row").filter({ hasText: "UPDATE invoices" }).click();
      await shoot(page, `waterfall-${look.name}-${density}`);
    }

  for (const look of THEMES) {
    await appearance(page, look, "calm");
    await openTrace(page, "POST /invoices/overdue");
    await page.getByRole("radio", { name: "Table" }).click();
    await shoot(page, `table-${look.name}-calm`);
    await page.getByRole("radio", { name: "Waterfall" }).click();
    await page.getByTestId("waterfall-services").hover();
    await page.getByTestId("waterfall-service").filter({ hasText: "fx-rates" }).hover();
    await shoot(page, `services-${look.name}-calm`, { hover: true });
    await page.mouse.move(700, 600);
    await openTrace(page, "test overdue-totals");
    await page.getByTestId("waterfall-errors-only").click();
    await shoot(page, `errors-only-${look.name}-calm`);
    await page.getByTestId("waterfall-errors-only").click();
    await openTrace(page, "POST /invoices/import");
    await shoot(page, `partial-${look.name}-calm`);
  }
};

/** Opens the 10,000-span trace, then scrolls its rows a step per frame and times each frame. */
const perf = async (page: Page) => {
  await open(page, "large");
  await appearance(page, THEMES[1], "calm");

  const opened = await page.evaluate(`(async () => {
    const row = document.querySelector('[data-testid="traces-row"]');
    const start = performance.now();
    row.click();
    while (!document.querySelector('[data-testid="waterfall-row"]')) await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  })()`);

  const scroll = await page.evaluate(`(async () => {
    const box = document.querySelector('[data-testid="waterfall-rows"]');
    const frames = [];
    let last = await new Promise(requestAnimationFrame);
    for (let i = 0; i < 600; i++) {
      box.scrollTop += 120;
      const now = await new Promise(requestAnimationFrame);
      frames.push(now - last);
      last = now;
    }
    const rows = document.querySelectorAll('[data-testid="waterfall-row"]').length;
    const sorted = [...frames].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const median = at(0.5);
    return {
      frames: frames.length,
      medianMs: median,
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      maxMs: sorted.at(-1),
      overOneAndAHalfFrames: frames.filter((f) => f > median * 1.5).length,
      domRows: rows,
      scrollHeight: box.scrollHeight,
    };
  })()`);

  await page.getByTestId("waterfall-collapse-all").click();

  const collapse = await page.evaluate(`(async () => {
    const button = document.querySelector('[data-testid="waterfall-collapse-all"]');
    const start = performance.now();
    button.click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  })()`);

  const result = { spans: 10_000, openMs: opened, expandAllMs: collapse, scroll };

  await page.screenshot({ path: join(out, "large-midnight-calm.png") });
  writeFileSync(join(out, "perf.json"), JSON.stringify(result, null, 2));
  console.log(`traces-waterfall: perf ${JSON.stringify(result)}`);
};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);

  if (!perfOnly) await screens(page);
  await perf(page);
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
