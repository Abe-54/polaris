#!/usr/bin/env node
/**
 * Traces' Profiles on fixtures (DESIGN.md, Traces → Sidebar, Profile; Paper T2): the Profiles tab
 * and ledger-api's flame chart under the overdue run in Moonlit, Midnight and light at every
 * density, a refused restart, then the 50,000-node Profile opened, zoomed, panned and scrolled
 * with frame times. Needs a built app.
 *
 *   node scripts/tracesProfileScreens.ts <out dir> [--perf-only]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-traces-profiles");

const perfOnly = process.argv.includes("--perf-only");

const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

const DENSITIES = ["calm", "balanced", "compact"] as const;

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-traces-profiles-"));

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const open = async (page: Page, view: string) => {
  await page.evaluate(`location.hash = "#traces/traces?view=${view}"; location.reload()`);
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

const shoot = async (page: Page, name: string) => {
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`traces-profiles: saved ${name}.png`);
};

/** The Profiles tab, ledger-api's recording open, fetchRate selected (three levels down). */
const profile = async (page: Page) => {
  await page.getByRole("radio", { name: /Profiles/ }).click();
  await page.getByTestId("flame-chart").waitFor();
  await page.getByTestId("flame-chart").focus();

  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
};

const screens = async (page: Page) => {
  for (const look of THEMES)
    for (const density of DENSITIES) {
      await open(page, "profile");
      await appearance(page, look, density);
      await profile(page);
      await shoot(page, `profile-${look.name}-${density}`);
    }

  await open(page, "restart-refused");

  for (const look of THEMES) {
    await appearance(page, look, "calm");
    await page.getByRole("radio", { name: /Profiles/ }).click();
    await page.getByTestId("profiles-restart").click();
    await page.getByTestId("profiles-refused").waitFor();
    await shoot(page, `restart-refused-${look.name}-calm`);
    await page.evaluate("location.reload()");
    await page.getByTestId("traces-mode").waitFor({ timeout: 20_000 });
  }
};

/** One wheel step on the flame chart per frame: zoom in, pan across, scroll levels, zoom out. */
const SWEEP = `(async () => {
  const chart = document.querySelector('[data-testid="flame-chart"]');
  const canvas = chart.querySelector("canvas");
  const rect = chart.getBoundingClientRect();
  const at = { clientX: rect.left + rect.width * 0.4, clientY: rect.top + 40, bubbles: true, cancelable: true };
  const steps = [
    ...Array.from({ length: 200 }, () => ({ ...at, deltaY: -12, ctrlKey: true })),
    ...Array.from({ length: 200 }, () => ({ ...at, deltaX: 30 })),
    ...Array.from({ length: 100 }, (_, i) => ({ ...at, deltaY: i % 40 < 20 ? 40 : -40 })),
    ...Array.from({ length: 200 }, () => ({ ...at, deltaX: -30 })),
    ...Array.from({ length: 200 }, () => ({ ...at, deltaY: 12, ctrlKey: true })),
  ];
  const frames = [];
  const draws = [];
  let most = 0;
  let last = await new Promise(requestAnimationFrame);
  for (const step of steps) {
    chart.dispatchEvent(new WheelEvent("wheel", step));
    const now = await new Promise(requestAnimationFrame);
    frames.push(now - last);
    draws.push(Number(canvas.dataset.drawMs ?? 0));
    most = Math.max(most, Number(canvas.dataset.drawn ?? 0));
    last = now;
  }
  const stats = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return { median: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.at(-1) };
  };
  const frame = stats(frames);
  return {
    steps: steps.length,
    frameMs: frame,
    overOneAndAHalfFrames: frames.filter((f) => f > frame.median * 1.5).length,
    drawMs: stats(draws),
    mostFramesDrawn: most,
  };
})()`;

/** Opens the 50,000-node Profile from the sidebar, then sweeps it and times each frame. */
const perf = async (page: Page) => {
  await open(page, "profile-large");
  await appearance(page, THEMES[1], "calm");
  await page.getByTestId("flame-chart").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Close profile" }).click();
  await page.getByRole("radio", { name: /Profiles/ }).click();

  const opened = await page.evaluate(`(async () => {
    const row = document.querySelector('[data-profile="prof-large"]');
    const start = performance.now();
    row.click();
    for (;;) {
      const canvas = document.querySelector('[data-testid="flame-chart"] canvas');
      if (canvas && Number(canvas.dataset.drawn ?? 0) > 0) break;
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - start;
  })()`);

  const sweep = await page.evaluate(SWEEP);
  const result = { nodes: 50_000, levels: 24, openMs: opened, sweep };

  await page.getByTestId("flame-chart").focus();
  await page.keyboard.press("ArrowDown");
  await shoot(page, "profile-large-midnight-calm");
  writeFileSync(join(out, "perf.json"), JSON.stringify(result, null, 2));
  console.log(`traces-profiles: perf ${JSON.stringify(result)}`);
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
