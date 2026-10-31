#!/usr/bin/env node
/**
 * The whole-app pass (ENG-499): every view on fixtures in Moonlit, Midnight and light at 1280×720,
 * the Orchestrator at every density, then Reduce Motion, the colourblind diff palette and the
 * keyboard's Tab order with its focus ring. Prints the Tab order it walked.
 *
 *   node scripts/wholeAppScreens.ts --out <dir> [--build] [--only orchestrator,review]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";

const args = process.argv.slice(2);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = option("--out");

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const only = option("--only")?.split(",") ?? null;

interface View {
  readonly group: string;
  readonly name: string;
  readonly hash: string;
  readonly ready: string;
  readonly densities?: ReadonlyArray<string>;
}

const ALL_DENSITIES = ["calm", "balanced", "compact"];

const VIEWS: ReadonlyArray<View> = [
  {
    group: "orchestrator",
    name: "session",
    hash: "#preview/session",
    ready: "[data-testid=session-panel]",
    densities: ALL_DENSITIES,
  },
  {
    group: "orchestrator",
    name: "new",
    hash: "#preview/new",
    ready: "[data-testid=new-session]",
    densities: ALL_DENSITIES,
  },
  {
    group: "orchestrator",
    name: "machines",
    hash: "#preview/worst-machines",
    ready: "[data-testid=session-panel], main",
  },
  {
    group: "orchestrator",
    name: "unknown-context",
    hash: "#preview/worst-supervised",
    ready: "[data-testid=session-panel]",
  },
  { group: "orchestrator", name: "empty", hash: "#preview/worst-empty", ready: "main" },
  { group: "orchestrator", name: "no-host", hash: "#preview/no-host", ready: "main" },
  { group: "review", name: "review", hash: "#review/xg", ready: "[data-testid=risk-finding]" },
  {
    group: "review",
    name: "review-chat",
    hash: "#review/xg-chat",
    ready: "[data-testid=reviewer-asks]",
  },
  {
    group: "constellation",
    name: "constellation",
    hash: "#constellation/chrome",
    ready: "main, [data-testid]",
  },
  { group: "editor", name: "editor", hash: "#editor/e3", ready: ".cm-content" },
  { group: "editor", name: "editor-terminal", hash: "#editor/e3?terminal", ready: ".cm-content" },
  {
    group: "settings",
    name: "appearance",
    hash: "#settings/appearance",
    ready: "main, [data-testid]",
  },
  { group: "settings", name: "usage", hash: "#settings/usage-heavy", ready: "main, [data-testid]" },
];

const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

type Theme = (typeof THEMES)[number];

const appearance = async (page: Page, theme: Theme, density: string, patch = "") => {
  // The dark theme is saved, not set on the root: a reload re-applies the saved one.
  const dark = theme.dark ?? "moonlit";

  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme.theme}", darkTheme: "${dark}", density: "${density}"${patch} } })`
  );
  await page
    .locator(
      `html[data-theme="${theme.theme}"][data-theme-dark="${dark}"][data-density="${density}"]`
    )
    .waitFor({ state: "attached" });
};

/** One pixel of a saved screenshot, as #rrggbb, decoded by Electron's nativeImage. */
const pixel = (path: string, point: { readonly x: number; readonly y: number }) =>
  app.evaluate(
    ({ nativeImage }, at) => {
      const image = nativeImage.createFromPath(at.path);

      const [b = 0, g = 0, r = 0] = image
        .crop({ x: at.x, y: at.y, width: 1, height: 1 })
        .toBitmap();

      return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    },
    { path, ...point }
  );

/** Midnight is true black: the ground, a panel and the moon's place (stars only, no moon). */
const checkMidnight = async (name: string, panelShown: boolean) => {
  const path = join(out, `${name}.png`);
  const ground = await pixel(path, { x: 8, y: 400 });
  const panel = panelShown ? await pixel(path, { x: 304, y: 400 }) : null;
  const moon = await pixel(path, { x: 105, y: 635 });
  // Moonlit's moon is #aeb5c4 there; Midnight has only the sky's faint glow.
  const dark = Math.max(...[1, 3, 5].map((i) => Number.parseInt(moon.slice(i, i + 2), 16))) < 0x20;
  const ok = ground === "#000000" && (panel === null || panel === "#0a0b0d") && dark;

  console.log(
    `midnight ${name}: ground ${ground} panel ${panel ?? "-"} moon ${moon} ${ok ? "ok" : "WRONG"}`
  );

  if (!ok) failures.push(name);
};

const failures: string[] = [];

const load = async (page: Page, view: View) => {
  await page.evaluate(`location.hash = ${JSON.stringify(view.hash)}; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.locator(view.ready).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
};

const shoot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`screens: ${path}`);
};

const FOCUSED = `(() => {
  const el = document.activeElement;
  if (el === null || el === document.body) return "(body)";
  const name = el.getAttribute("aria-label") ?? el.getAttribute("data-testid") ?? (el.textContent ?? "").trim().slice(0, 40);
  return el.tagName.toLowerCase() + " · " + name;
})()`;

/** Tabs through the session view, recording each stop, with the ring shot at the first few. */
const tabOrder = async (page: Page) => {
  const stops: string[] = [];

  await page.locator("body").click({ position: { x: 1, y: 1 } });

  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate<string>(FOCUSED));

    if (i < 4 || i % 6 === 0) await shoot(page, `keyboard-tab-${String(i + 1).padStart(2, "0")}`);
  }

  writeFileSync(join(out, "keyboard-order.txt"), `${stops.join("\n")}\n`);
  console.log(`tab order:\n${stops.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
};

const home = mkdtempSync("/tmp/pwa-");

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: join(home, "user-data"),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

try {
  const page = await app.firstWindow();

  mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  for (const view of VIEWS) {
    if (only !== null && !only.includes(view.group)) continue;

    for (const density of view.densities ?? ["calm"])
      for (const theme of THEMES) {
        await appearance(page, theme, density);
        await load(page, view);
        await shoot(page, `${view.name}-${theme.name}-${density}`);

        if (
          theme.name === "midnight" &&
          view.group === "orchestrator" &&
          view.densities !== undefined
        )
          await checkMidnight(`${view.name}-${theme.name}-${density}`, view.name === "session");
      }
  }

  if (only === null || only.includes("modes")) {
    const session = VIEWS[0]!;
    const review = VIEWS.find((v) => v.name === "review")!;

    await appearance(page, THEMES[0], "calm", `, motion: "reduce"`);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await load(page, session);
    await shoot(page, "reduce-motion-session-moonlit");
    await page.emulateMedia({ reducedMotion: null });
    await appearance(page, THEMES[0], "calm", `, motion: "system"`);

    for (const theme of THEMES) {
      await appearance(page, theme, "calm", `, diffPalette: "cvd"`);
      await load(page, review);
      await shoot(page, `cvd-review-${theme.name}`);
    }

    await appearance(page, THEMES[0], "calm", `, diffPalette: "default"`);
    await load(page, session);
    await tabOrder(page);
  }

  if (failures.length > 0) process.exitCode = 1;
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
