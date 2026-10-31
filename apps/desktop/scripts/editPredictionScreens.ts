#!/usr/bin/env node
/**
 * Screenshots of the Editor's Edit Prediction display states on fixtures
 * (`#edit-prediction/<scene>`) against Paper EP1–EP6a and EP5: both themes, every density, and the
 * colourblind palette for the tinted states. No Daemon: the preview serves its file from memory.
 *
 *   node scripts/editPredictionScreens.ts --out <dir> [--build] [--quick] [--scenes a,b]
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

const ALL = [
  "replace",
  "multiline",
  "delete",
  "delete-large",
  "jump",
  "jump-offscreen",
  "jumped",
  "subtle",
  "subtle-held",
  "insert",
  "import",
  "import-subtle",
];

const scenes = flag("--scenes")?.split(",") ?? ALL;

const quick = args.includes("--quick");

const home = mkdtempSync(join(tmpdir(), "polaris-edit-prediction-"));

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ welcomeSeen: true, local: { enabled: false } })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: { ...process.env, POLARIS_DESKTOP_USER_DATA: userData, POLARIS_DESKTOP_HIDDEN: "1" },
});

const appearance = async (page: Page, theme: string, density: string, palette = "default") => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "${density}", diffPalette: "${palette}" } })`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

const open = async (page: Page, scene: string) => {
  await page.evaluate(`location.hash = "#edit-prediction/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page
    .locator(".cm-ep-hint, .cm-prediction-inline, .cm-ep-edge")
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
};

const shoot = async (page: Page, name: string) => {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  console.log(`screens: ${path}`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`));
  mkdirSync(out, { recursive: true });

  for (const scene of scenes) {
    for (const density of quick ? ["balanced"] : ["calm", "balanced", "compact"]) {
      for (const theme of quick ? ["dark"] : ["dark", "light"]) {
        await appearance(page, theme, density);
        await open(page, scene);
        await shoot(page, `${scene}-${theme}-${density}`);
      }
    }
  }

  for (const scene of ["replace", "multiline", "delete"].filter((s) => scenes.includes(s))) {
    for (const theme of quick ? ["dark"] : ["dark", "light"]) {
      await appearance(page, theme, "balanced", "cvd");
      await open(page, scene);
      await shoot(page, `${scene}-${theme}-balanced-cvd`);
    }
  }

  await appearance(page, "dark", "balanced");
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
