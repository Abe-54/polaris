#!/usr/bin/env node
/**
 * Screenshots of the shell's Constellation parts on fixtures (`#constellations/<scene>`) at
 * 1440×900, against Paper C1–C5: both themes, and every density unless `--quick`.
 *
 *   node scripts/constellationScreens.ts --out <dir> [--build] [--quick] [--scene <name>]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";
import { startDaemon } from "./lib/daemon.ts";

const args = process.argv.slice(2);

const flag = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = flag("--out");

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

/** Each scene and the test id that says it has painted. */
const SCENES = new Map([
  ["sidebar", "lead-group"],
  ["sidebar-tree", "lead-group"],
  ["focus", "lead-group"],
  ["needs-you", "constellation-needs-you"],
  ["needs-you-setup", "constellation-needs-you"],
  ["review", "worker-review-action"],
  ["defaults", "constellation-defaults"],
  ["hosts", "host-resources"],
  ["usage", "usage-by-constellation"],
]);

type Step = (page: Page) => Promise<void>;

/** What a scene does before its test id shows: open a row, scroll to a section. */
const PREPARE = new Map<string, Step>([
  [
    "hosts",
    async (page) => {
      await page
        .getByRole("button", { name: /^Mac Studio/ })
        .first()
        .click();
    },
  ],
]);

/** What a scene shows once painted, before each shot. */
const SHOW = new Map<string, Step>([
  [
    "sidebar-tree",
    async (page) => {
      await page.locator('[data-testid="worker-row"][data-task="F3"]').scrollIntoViewIfNeeded();
    },
  ],
  [
    "usage",
    async (page) => {
      await page.getByTestId("usage-by-constellation").scrollIntoViewIfNeeded();
      await page.getByTestId("usage-constellation").first().click();
    },
  ],
  [
    "hosts",
    async (page) => {
      await page.getByTestId("host-resources").scrollIntoViewIfNeeded();
    },
  ],
]);

const only = flag("--scene");

const scenes = [...SCENES.keys()].filter((s) => only === null || s === only);

const densities = args.includes("--quick") ? ["calm"] : ["calm", "balanced", "compact"];

const home = mkdtempSync(join(tmpdir(), "polaris-constellations-"));

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
    `Promise.all([window.polaris.request("settings.setTheme", { theme: "${theme}" }), window.polaris.request("settings.setDensity", { density: "${density}" })])`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

try {
  const page = await app.firstWindow();

  page.on("console", (m) => {
    if (m.type() === "error") console.error(`renderer: ${m.text()}`);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });

  for (const scene of scenes) {
    await page.evaluate(`location.hash = "#constellations/${scene}"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    await PREPARE.get(scene)?.(page);
    await page
      .getByTestId(SCENES.get(scene) ?? "")
      .first()
      .waitFor({ timeout: 15_000 });
    await SHOW.get(scene)?.(page);

    for (const density of densities) {
      for (const theme of ["dark", "light"]) {
        await appearance(page, theme, density);

        const path = join(out, `${scene}-${theme}-${density}.png`);

        await page.screenshot({ path });
        console.log(`screens: ${path}`);
      }
    }

    if (scene === "review") {
      await page.getByRole("button", { name: "More review options" }).click();
      await page.getByTestId("worker-merge").waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, "review-menu.png") });
      await page.keyboard.press("Escape");
    }
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
