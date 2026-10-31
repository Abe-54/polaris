#!/usr/bin/env node
/**
 * Screenshots of the Constellation tab on fixtures (`#constellation/<scene>`) at 1440×900
 * against Paper C1–C9, Moonlit, Midnight and light, and every density; `--frames` scrolls the
 * 128-Task scene. The completed scene also shoots its card alone at 1440, 900 and 2560 wide.
 *
 *   node scripts/constellationTabScreens.ts --out <dir> [--build] [--scenes lead,focus] [--frames]
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

const ALL = [
  "lead",
  "menu",
  "focus",
  "handed",
  "handed-unmerged",
  "handed-menu",
  "handed-approved",
  "paused",
  "empty",
  "large",
  "handover",
  "stats",
  "completed",
  "setup",
  "setup-focus",
  "slugs",
  "tree",
  "startup",
];

const scenes = flag("--scenes")?.split(",") ?? ALL;

const densities = args.includes("--all-densities") ? ["calm", "balanced", "compact"] : ["calm"];

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-constellation-"));

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR, "--use-mock-keychain"],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const THEMES = [
  { name: "moonlit", theme: "dark", dark: "moonlit" },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: "moonlit" },
] as const;

const appearance = async (page: Page, t: (typeof THEMES)[number], density: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${t.theme}", darkTheme: "${t.dark}", density: "${density}" } })`
  );
  await page
    .locator(
      `html[data-theme="${t.theme}"][data-theme-dark="${t.dark}"][data-density="${density}"]`
    )
    .waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

/** The completion card on its own, at the tab's width and then in a narrow window. */
const completionCard = async (page: Page, name: string) => {
  const card = page.getByTestId("completion-card");

  await card.screenshot({ path: join(out, `${name}-card.png`) });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(300);
  await card.screenshot({ path: join(out, `${name}-card-narrow.png`) });
  await page.setViewportSize({ width: 2560, height: 1100 });
  await page.waitForTimeout(300);
  await card.screenshot({ path: join(out, `${name}-card-wide.png`) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  console.log(`screens: ${join(out, `${name}-card.png`)} (and -narrow, -wide)`);
  await railUnderCard(page, name);
};

/** The card scrolls with the rail: its first row sits under the card, and the rail scrolls to its end. */
const railUnderCard = async (page: Page, name: string) => {
  const rail = `document.querySelector('[data-testid="constellation-rail"]')`;

  const gap = Number(
    await page.evaluate(`(() => {
    const card = document.querySelector('[data-testid="completion-card"]').getBoundingClientRect();
    const row = ${rail}.querySelector('[role="listitem"]').getBoundingClientRect();
    return row.top - card.bottom;
  })()`)
  );

  if (!(gap >= 0)) throw new Error(`the first row overlaps the card (${gap}px)`);
  await page.evaluate(`${rail}.scrollTo(0, ${rail}.scrollHeight)`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${name}-scrolled.png`) });
  await page.evaluate(`${rail}.scrollTo(0, 0)`);
  console.log(`screens: ${join(out, `${name}-scrolled.png`)} (first row ${gap}px under the card)`);
};

/** Frame intervals while the 128-Task rail scrolls end to end and back. */
const frames = async (page: Page) => {
  const result = await page.evaluate(`(async () => {
    const list = document.querySelector('[data-testid="constellation-rail"]');
    const times = [];
    let last = performance.now();
    let running = true;
    const tick = (t) => { times.push(t - last); last = t; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    for (let i = 0; i < 120; i++) {
      list.scrollTop = (i % 60) * 40;
      await new Promise((r) => requestAnimationFrame(r));
    }
    running = false;
    const sorted = times.slice(5).sort((a, b) => a - b);
    const idle = [];
    let prev = performance.now();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      idle.push(t - prev);
      prev = t;
    }
    idle.sort((a, b) => a - b);
    return { n: sorted.length, idleP50: idle[30], p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1] };
  })()`);

  console.log(`screens: large scroll frames ${JSON.stringify(result)}`);
};

try {
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(out, { recursive: true });
  page.on("pageerror", (error) => console.log(`screens: page error: ${error.message}`));

  for (const scene of scenes) {
    await page.evaluate(`location.hash = "#constellation/${scene}"`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("constellation-tab").waitFor();

    if (scene === "handed-unmerged") {
      await page.getByRole("button", { name: "Accept B1" }).click();
      await page.getByTestId("claim-refused").waitFor();
    }

    for (const density of densities) {
      for (const t of THEMES) {
        await appearance(page, t, density);
        const theme = t.name;
        const path = join(out, `${scene}-${theme}-${density}.png`);

        await page.screenshot({ path });
        console.log(`screens: ${path}`);

        if (scene === "completed") await completionCard(page, `${scene}-${theme}-${density}`);

        if (scene === "stats") {
          const end = join(out, `${scene}-end-${theme}-${density}.png`);

          const popover = `document.querySelector('[data-testid="stats-popover"] [data-slot="instrument-body"]')`;

          await page.evaluate(`${popover}.scrollTo(0, ${popover}.scrollHeight)`);
          await page.screenshot({ path: end });
          await page.evaluate(`${popover}.scrollTo(0, 0)`);
          console.log(`screens: ${end}`);
        }
      }
    }

    if (scene === "large" && args.includes("--frames")) await frames(page);
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
