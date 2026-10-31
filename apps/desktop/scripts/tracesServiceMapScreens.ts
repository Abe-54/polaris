#!/usr/bin/env node
/**
 * Traces' Service map on fixtures (`#traces/<scene>`, DESIGN.md Traces → Service map) in Moonlit,
 * Midnight and light at every density, then the 10,000-span, 30-service trace (`#traces/mesh`)
 * opened on the map, zoomed and panned a step per frame, with frame times. Needs a built app.
 *
 *   node scripts/tracesServiceMapScreens.ts <out dir> [--perf-only]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type Page } from "playwright-core";
import { APP_DIR, electronBinary, sizeWindow } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-traces-map");

const perfOnly = process.argv.includes("--perf-only");

const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

const DENSITIES = ["calm", "balanced", "compact"] as const;

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-traces-map-"));

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

const openMap = async (page: Page, root: string) => {
  await page.getByTestId("traces-row").filter({ hasText: root }).first().click();
  await page.getByTestId("waterfall-toolbar").waitFor();
  await page.getByRole("radio", { name: "Service map" }).click();
  await page.getByTestId("map-node").first().waitFor();
};

const shoot = async (page: Page, name: string) => {
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`traces-map: saved ${name}.png`);
};

const node = (page: Page, name: string) =>
  page.locator(`[data-testid="map-node"][data-node="${name}"]`);

const screens = async (page: Page) => {
  await open(page, "traces");

  for (const look of THEMES)
    for (const density of DENSITIES) {
      await appearance(page, look, density);
      await openMap(page, "settlements.run");
      await node(page, "notifier").click();
      await shoot(page, `map-${look.name}-${density}`);
    }

  for (const look of THEMES) {
    await appearance(page, look, "calm");
    await openMap(page, "POST /invoices/overdue");
    await shoot(page, `overdue-${look.name}-calm`);
    await openMap(page, "test overdue-totals");
    await node(page, "fx-rates.internal").click();
    await shoot(page, `failing-test-${look.name}-calm`);
    await openMap(page, "settlements.run");
    await page.getByTestId("waterfall-errors-only").click();
    await shoot(page, `errors-only-${look.name}-calm`);
    await page.getByTestId("waterfall-errors-only").click();
  }
};

/** Frame times while `step` runs once per frame for 300 frames. */
const frames = (step: string) => `(async () => {
  const box = document.querySelector('[data-testid="service-map"] [role="group"]');
  const rect = box.getBoundingClientRect();
  const frames = [];
  let last = await new Promise(requestAnimationFrame);
  for (let i = 0; i < 300; i++) {
    ${step}
    const now = await new Promise(requestAnimationFrame);
    frames.push(now - last);
    last = now;
  }
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const median = at(0.5);
  return { frames: frames.length, medianMs: median, p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1), overOneAndAHalfFrames: frames.filter((f) => f > median * 1.5).length };
})()`;

const ZOOM = `box.dispatchEvent(new WheelEvent("wheel", { deltaY: i < 150 ? -12 : 12, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));`;

const PAN = `if (i === 0) box.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, button: 0, clientX: rect.left + 200, clientY: rect.top + 200, bubbles: true }));
    box.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: rect.left + 200 + Math.sin(i / 20) * 300, clientY: rect.top + 200 + Math.cos(i / 20) * 150, bubbles: true }));
    if (i === 299) box.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, bubbles: true }));`;

/** Opens the 10,000-span, 30-service trace on the map, then zooms and pans it a step per frame. */
const perf = async (page: Page) => {
  await open(page, "mesh");
  await appearance(page, THEMES[1], "calm");
  await page.getByTestId("traces-row").first().click();
  await page.getByTestId("waterfall-toolbar").waitFor();

  const opened = await page.evaluate(`(async () => {
    const radio = [...document.querySelectorAll('[role="radio"]')].find((r) => r.textContent === "Service map");
    const start = performance.now();
    radio.click();
    while (!document.querySelector('[data-testid="map-node"]')) await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  })()`);

  const nodes = await page.getByTestId("map-node").count();
  const edges = await page.getByTestId("map-edge").count();

  await shoot(page, "mesh-midnight-calm");
  const zoom = await page.evaluate(frames(ZOOM));
  const pan = await page.evaluate(frames(PAN));

  await page
    .getByTestId("service-map")
    .locator('[role="group"]')
    .dblclick({ position: { x: 20, y: 20 } });
  await shoot(page, "mesh-midnight-calm-fit");
  const result = { spans: 10_000, nodes, edges, openMs: opened, zoom, pan };

  writeFileSync(join(out, "perf.json"), JSON.stringify(result, null, 2));
  console.log(`traces-map: perf ${JSON.stringify(result)}`);
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
