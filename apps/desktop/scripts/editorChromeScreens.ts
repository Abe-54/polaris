#!/usr/bin/env node
/**
 * Screenshots of the Editor in the new chrome (Paper X-I Variant C) on fixtures: the terminal
 * hidden and shown, the status row's morph between them, a narrow window, and the tab completion
 * card (X-F 10), in Moonlit, Midnight and light. No Daemon: the previews serve fixtures.
 *
 *   node scripts/editorChromeScreens.ts --out <dir> [--build] [--densities calm,compact]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";

const args = process.argv.slice(2);

const flag = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = flag("--out");

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const densities = (flag("--densities") ?? "calm").split(",");

/** The dark flavour is the root's `data-theme-dark`; unset is Moonlit. */
const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

type Theme = (typeof THEMES)[number];

const home = mkdtempSync(join(tmpdir(), "pec-"));

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ welcomeSeen: true, local: { enabled: false } })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: { ...process.env, POLARIS_DESKTOP_USER_DATA: userData, POLARIS_DESKTOP_HIDDEN: "1" },
});

const appearance = async (page: Page, { theme, dark: next }: Theme, density: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  flavour = next;
  await dark(page);
  await page.waitForTimeout(300);
};

let flavour: Theme["dark"] = null;

/** A reload drops the root's `data-theme-dark`, so it is set again after every load. */
const dark = (page: Page) =>
  page.evaluate(
    flavour === null
      ? `delete document.documentElement.dataset.themeDark`
      : `document.documentElement.dataset.themeDark = "${flavour}"`
  );

const load = async (page: Page, hash: string, ready: string) => {
  await page.evaluate(`location.hash = "${hash}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.locator(ready).first().waitFor({ timeout: 20_000 });
  await dark(page);
  await page.waitForTimeout(700);
};

const shot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.screenshot({ path });
  console.log(`screens: ${path}`);
};

/** Fails the run when the status row overflows its strip. */
const rowFits = async (page: Page, where: string) => {
  const overflow = Number(
    await page.evaluate(
      `(() => { const row = document.querySelector('[data-slot="status-row"] > *'); return row === null ? 0 : row.scrollWidth - row.clientWidth; })()`
    )
  );

  if (overflow > 1) throw new Error(`screens: ${where}: the status row overflows by ${overflow}px`);
};

try {
  const page = await app.firstWindow();

  mkdirSync(out, { recursive: true });

  for (const density of densities)
    for (const theme of THEMES)
      for (const [scene, hash] of [
        ["hidden", "#editor/e3"],
        ["shown", "#editor/e3?terminal"],
        ["vim", "#editor/vim"],
      ] as const)
        for (const width of [1440, 1280]) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 720 });
          await appearance(page, theme, density);
          await load(page, hash, ".cm-content");
          await rowFits(page, `${scene} ${theme.name} ${width}`);
          await shot(page, `editor-${scene}-${theme.name}-${density}-${width}`);
        }

  // The morph: the chip opens the terminal, the row lifts into its strip (mid-flight, then settled).
  await page.setViewportSize({ width: 1440, height: 900 });
  await appearance(page, THEMES[1], "calm");
  await load(page, "#editor/e3", ".cm-content");
  await page.getByTestId("terminal-toggle").click();
  await page.waitForTimeout(90);
  await shot(page, "editor-morph-midway-midnight");
  await page.waitForTimeout(400);
  await shot(page, "editor-morph-settled-midnight");

  // A narrow editor: Completions drops to its glyph, then the branch truncates in the middle.
  for (const width of [1100, 900]) {
    await page.setViewportSize({ width, height: 720 });
    await load(page, "#editor/vim", ".cm-content");
    await rowFits(page, `narrow ${width}`);
    await shot(page, `editor-narrow-midnight-${width}`);
  }

  for (const theme of THEMES) {
    await page.setViewportSize({ width: 1640, height: 1500 });
    await appearance(page, theme, "calm");
    await load(page, "#completion-card/states", "[data-scene]");
    await shot(page, `completion-states-${theme.name}`);

    for (const scene of ["next-edit", "failed", "no-server", "downloading"]) {
      const path = join(out, `completion-${scene}-${theme.name}.png`);

      await page.locator(`[data-scene="${scene}"]`).screenshot({ path });
      console.log(`screens: ${path}`);
    }

    // The real status item at 1280×720: the card fits above it, only its body scrolls.
    await page.setViewportSize({ width: 1280, height: 720 });
    await load(page, "#completion-card/bar", '[data-testid="prediction-status"]');
    await page.getByTestId("prediction-status").click();
    await page.getByTestId("completion-card").waitFor();
    await page.waitForTimeout(500);
    await shot(page, `completion-bar-${theme.name}-1280`);
  }
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
