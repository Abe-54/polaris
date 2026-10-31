#!/usr/bin/env node
/**
 * Screenshots of the editor on fixtures (`#editor/<scene>`) against Paper E1–E3:
 * both themes and every density, plus the colourblind palette for the conflict's
 * Compare. No Daemon: the preview serves its files from memory.
 *
 *   node scripts/editorScreens.ts --out <dir> [--build] [--scenes e1,conflict]
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

if (args.includes("--build")) {
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });
}

const ALL = [
  "e1",
  "e3",
  "close",
  "conflict",
  "compare",
  "reload",
  "vim",
  "find",
  "tabs20",
  "readonly",
  "binary",
  "empty",
];

const scenes = flag("--scenes")?.split(",") ?? ALL;

const home = mkdtempSync(join(tmpdir(), "polaris-editor-screens-"));

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
  await page.evaluate(`location.hash = "#editor/${scene}"; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  const ready = scene === "empty" ? "No file open" : null;

  if (scene === "close") await page.getByTestId("editor-close-dialog").waitFor({ timeout: 20_000 });
  else if (ready === null)
    await page
      .locator(".cm-content, [data-testid=editor-pane] [role=status]")
      .first()
      .waitFor({ timeout: 20_000 });
  else await page.getByText(ready).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(scene === "reload" ? 250 : 700);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  for (const scene of scenes) {
    for (const density of ["calm", "balanced", "compact"]) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);
        await open(page, scene);
        const path = join(out, `${scene}-${theme}-${density}.png`);

        await page.screenshot({ path });
        console.log(`screens: ${path}`);
      }
    }
  }

  if (scenes.includes("compare")) {
    await appearance(page, "dark", "calm", "cvd");
    await open(page, "compare");
    await page.screenshot({ path: join(out, "compare-dark-calm-cvd.png") });
    await appearance(page, "dark", "calm");
  }
} finally {
  await app.close();
  rmSync(home, { recursive: true, force: true });
}
