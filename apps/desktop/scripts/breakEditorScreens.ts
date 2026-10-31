#!/usr/bin/env node
/**
 * The break-UI pass on the Editor and Settings (ENG-499), on fixtures without a Daemon: the status
 * row with a 121-character branch and every item (`#editor/worst?git=worst&host=…`), vim modes, 40
 * tabs, the terminal toggled mid-morph, the completion card's worst states (`#completion-card/worst`)
 * and Settings → Usage and Appearance (`#settings/…`) at every density. Prints each check it fails.
 *
 *   node scripts/breakEditorScreens.ts --out <dir> [--build] [--only editor,card,settings]
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

const only = (flag("--only") ?? "editor,card,settings").split(",");

const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

type Theme = (typeof THEMES)[number];

const home = mkdtempSync(join(tmpdir(), "pbe-"));

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

const failures: string[] = [];

let flavour: Theme["dark"] = null;

const dark = (page: Page) =>
  page.evaluate(
    flavour === null
      ? `delete document.documentElement.dataset.themeDark`
      : `document.documentElement.dataset.themeDark = "${flavour}"`
  );

const appearance = async (page: Page, { theme, dark: next }: Theme, density = "calm") => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  flavour = next;
  await dark(page);
  await page.waitForTimeout(200);
};

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

/** Records (doesn't throw) a status row wider than its strip, or an item pushed past its edge. */
const rowFits = async (page: Page, where: string) => {
  const report = String(
    await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-slot="status-row"]')];
      if (rows.length !== 1) return "rows: " + rows.length;
      const row = rows[0].firstElementChild;
      if (row === null) return "";
      const over = row.scrollWidth - row.clientWidth;
      const edge = row.getBoundingClientRect().right;
      const clipped = [...row.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > edge + 1 && e.getClientRects().length > 0).map((e) => (e.textContent ?? "").slice(0, 24));
      return over > 1 ? "overflows by " + over + "px: " + clipped.slice(0, 3).join(" | ") : "";
    })()`)
  );

  if (report !== "") {
    failures.push(`${where}: ${report}`);
    console.log(`FAIL ${where}: ${report}`);
  }
};

const status = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);

  await page.locator('[data-slot="status-row"]').screenshot({ path });
  console.log(`screens: ${path}`);
};

const WORST = "#editor/worst?git=worst";

const editor = async (page: Page) => {
  for (const theme of THEMES) {
    await appearance(page, theme);

    for (const width of [1440, 1280, 1100, 900, 760]) {
      await page.setViewportSize({ width, height: 720 });
      await load(page, `${WORST}&host=remote`, ".cm-content");
      await rowFits(page, `worst remote ${theme.name} ${width}`);
      await shot(page, `editor-worst-remote-${theme.name}-${width}`);
      await status(page, `status-worst-remote-${theme.name}-${width}`);
    }

    await page.setViewportSize({ width: 1280, height: 720 });

    for (const host of ["local", "reconnecting", "offline"]) {
      await load(page, `${WORST}&host=${host}`, ".cm-content");
      await rowFits(page, `worst ${host} ${theme.name}`);
      await status(page, `status-worst-${host}-${theme.name}-1280`);
    }

    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 720 });
      await load(page, `${WORST}&host=remote&terminal`, ".cm-content");
      await rowFits(page, `worst terminal ${theme.name} ${width}`);
      await shot(page, `editor-worst-terminal-${theme.name}-${width}`);
    }
  }

  // Vim modes, in Midnight at 1100: each badge with the long branch beside it.
  await appearance(page, THEMES[1]);
  await page.setViewportSize({ width: 1100, height: 720 });
  await load(page, `${WORST}&host=remote`, ".cm-content");
  await page.locator(".cm-content").click();

  for (const [mode, keys] of [
    ["normal", ["Escape"]],
    ["insert", ["i"]],
    ["visual", ["Escape", "v", "l", "l"]],
    ["visual-line", ["Escape", "Escape", "Shift+V"]],
    ["visual-block", ["Escape", "Escape", "Control+v", "j"]],
    ["replace", ["Escape", "Escape", "Shift+R"]],
  ] as const) {
    for (const key of keys) await page.keyboard.press(key);
    await page.waitForTimeout(150);
    await rowFits(page, `vim ${mode}`);
    await status(page, `status-vim-${mode}-midnight-1100`);
  }

  // 40 tabs: the active one in view, then the last.
  await page.setViewportSize({ width: 1280, height: 720 });
  await load(page, "#editor/tabs40", ".cm-content");
  await shot(page, "editor-tabs40-midnight-1280");
  await page.evaluate(`document.querySelector('[role="tablist"]').scrollLeft = 1e6`);
  await page.waitForTimeout(100);
  await shot(page, "editor-tabs40-end-midnight-1280");

  // The terminal toggled every 60ms, five times, mid-morph: one row, where it belongs, fitting.
  await load(page, `${WORST}&host=remote`, ".cm-content");

  for (let i = 0; i < 5; i++) {
    await page.evaluate(`window.__polarisTerminal()`);
    await page.waitForTimeout(60);
  }

  await shot(page, "editor-toggle-midflight-midnight");
  await page.waitForTimeout(500);

  const placement = String(
    await page.evaluate(
      `[...document.querySelectorAll('[data-slot="status-row"]')].map((r) => r.dataset.placement + ":" + getComputedStyle(r).transform + ":" + r.getAnimations().length).join(",")`
    )
  );

  if (placement !== "strip:none:0") failures.push(`toggle: settled as ${placement}`);
  await rowFits(page, "toggle settled");
  await shot(page, "editor-toggle-settled-midnight");
};

const card = async (page: Page) => {
  for (const theme of THEMES) {
    await page.setViewportSize({ width: 1640, height: 1800 });
    await appearance(page, theme);
    await load(page, "#completion-card/worst", "[data-scene]");
    await shot(page, `card-worst-${theme.name}`);

    for (const scene of ["many-models", "many-models-huge", "no-models", "failed-long"]) {
      const path = join(out, `card-${scene}-${theme.name}.png`);

      await page.locator(`[data-scene="${scene}"]`).screenshot({ path });
      console.log(`screens: ${path}`);
    }

    // The real status item at 1280×720 in the worst status row: the card fits above it.
    await page.setViewportSize({ width: 1280, height: 720 });
    await load(page, `${WORST}&host=remote`, '[data-testid="prediction-status"]');
    await page.getByTestId("prediction-status").click();
    await page.waitForTimeout(500);
    await shot(page, `card-in-worst-row-${theme.name}-1280`);
  }
};

const settings = async (page: Page) => {
  for (const theme of THEMES)
    for (const density of ["calm", "balanced", "compact"])
      for (const scene of ["usage-heavy", "usage-one", "usage-empty", "usage-none", "appearance"]) {
        if (scene !== "usage-heavy" && scene !== "appearance" && density !== "calm") continue;

        for (const [width, height] of [
          [1280, 2400],
          [900, 2400],
        ] as const) {
          await page.setViewportSize({ width, height });
          await appearance(page, theme, density);
          await load(page, `#settings/${scene}`, "main, [data-testid]");
          await page.waitForTimeout(400);
          await shot(page, `settings-${scene}-${theme.name}-${density}-${width}`);
        }
      }
};

try {
  const page = await app.firstWindow();

  mkdirSync(out, { recursive: true });

  if (only.includes("editor")) await editor(page);

  if (only.includes("card")) await card(page);

  if (only.includes("settings")) await settings(page);
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} checks failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
}
