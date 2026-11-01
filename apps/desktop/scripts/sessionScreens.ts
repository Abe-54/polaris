#!/usr/bin/env node
/**
 * Screenshots of the session view on fixtures (`#preview/<scene>`), at the
 * artboards' 1440×900, in both themes and every density, for comparing with
 * Paper's `11U-0` and `VG-0`.
 *
 *   node scripts/sessionScreens.ts --out <dir> [--build] [--scenes session,new]
 *     [--size 1280x720] [--themes dark,midnight,light]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { startDaemon } from "./lib/daemon.ts";
import { frameStats } from "./lib/sessionFlow.ts";

const args = process.argv.slice(2);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const out = option("--out");

if (out === null) throw new Error("--out <dir> is required");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const scenes = (
  option("--scenes") ?? "session,approval,question,interrupted,new,setup,picker,availability"
).split(",");

/** Scroll the long scene's conversation at 4000 px/s for 5 s and report frame intervals. */
const scrollFrames = `new Promise((resolve) => {
  const el = document.querySelector('[data-testid="conversation"]');
  el.scrollTop = 0;
  const times = [];
  const start = performance.now();
  const tick = (t) => {
    times.push(t);
    el.scrollTop = ((t - start) / 1000) * 4000;
    if (t - start < 5000) requestAnimationFrame(tick); else resolve({ times, height: el.scrollHeight });
  };
  requestAnimationFrame(tick);
})`;

const SHOT_SCENES = new Map([
  ["picker", "interrupted"],
  ["availability", "new"],
  ["viewer", "attachments"],
  ["commands", "interrupted"],
  ["chip", "interrupted"],
  ["subagent-open", "subagents"],
  ["subagent-hover", "subagents"],
  ["subagent-tab", "subagents"],
  ["background-hover", "background"],
  ["background-row", "background"],
  ["background-open", "background"],
  ["context", "session"],
  ["image", "items"],
  ["command-open", "items"],
  ["polaris-lead", "polaris"],
  ["polaris-worker", "polaris"],
  ["polaris-raw", "polaris"],
  ["polaris-notify", "polaris"],
  ["windows-hover", "windows"],
  ["jump", "long"],
]);

/** The long scene scrolled up by the wheel: the jump-to-latest arrow shows over the composer. */
const scrollAway = async (page: Page) => {
  await page.getByTestId("conversation").hover();
  await page.mouse.wheel(0, -900);
  await page.locator('[data-testid="jump-to-latest"][data-shown="true"]').waitFor();
  await page.mouse.move(0, 0);
};

/** "This PC" just upgraded: the top bar's Host label hovered, showing the stop's note. */
const hoverUpgradedHost = async (page: Page) => {
  await page.locator('[data-host="local"]').first().hover();
  await page.getByTestId("upgrade-note").waitFor();
};

/** Paper 14's open rows: the Lead's calls, the worker's, and one call's raw input and reply. */
const POLARIS_OPEN = new Map([
  ["polaris-lead", ["p1", "p3", "p5", "p9", "p10"]],
  ["polaris-worker", ["w1"]],
  ["polaris-notify", ["w6", "w9", "w10"]],
  ["polaris-raw", ["p2"]],
]);

const openPolaris = async (page: Page, scene: string) => {
  const ids = POLARIS_OPEN.get(scene) ?? [];

  const scroll = (by: number | null) =>
    page.evaluate(
      `(() => { const el = document.querySelector('[data-testid="conversation"]'); ${by === null ? "el.scrollTop = 0" : `el.scrollTop += ${by}`}; })()`
    );

  await scroll(null);

  // The list is virtualized: scroll down until each row is mounted.
  for (const id of ids) {
    const line = page.locator(`[data-testid="polaris-tool"][data-item="${id}"] > button`);

    // A row can unmount while the list settles; find it again and retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let step = 0; step < 40 && (await line.count()) === 0; step++) await scroll(240);

      const placed = await line
        .scrollIntoViewIfNeeded({ timeout: 2000 })
        .then(() => true)
        .catch(() => false);

      if (placed) break;
    }

    if ((await line.getAttribute("aria-expanded")) !== "true") await line.click();
  }

  const showRaw = page.getByTestId("polaris-tool-show-raw").filter({ hasText: "Show raw" });

  if (scene === "polaris-raw" && (await showRaw.count()) > 0) await showRaw.first().click();
  await page
    .locator(`[data-testid="polaris-tool"][data-item="${ids[0]}"]`)
    .scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
};

/** The subagents scene's first run and Subagent, opened; or the working one's activity hovered. */
const openSubagent = async (page: Page, scene: string) => {
  if (scene === "subagent-hover") {
    await page.locator('[data-testid="subagent-activity"]').first().hover();

    return;
  }

  if (scene === "subagent-tab") {
    if ((await page.getByTestId("subagent-pane").count()) === 0)
      await page.locator('[data-testid="composer-moon"]:visible').first().click();
    await page.getByTestId("subagent-pane").waitFor();

    return;
  }

  for (const target of [
    '[data-testid="tool-run"] > button',
    '[data-testid="subagent-head"] button[aria-expanded]',
  ])
    if ((await page.locator(`${target}[aria-expanded="true"]`).count()) === 0)
      await page.locator(target).first().click();
  await page.getByTestId("subagent-transcript").first().waitFor();
};

/** The background scene's shots: a hover listing the tasks, or the reported Subagent opened. */
const openBackground = async (page: Page, scene: string) => {
  if (scene === "background-open") {
    const card = page
      .locator(
        '[data-testid="subagent"][data-status="completed"] [data-testid="subagent-head"] button[aria-expanded]'
      )
      .first();

    if ((await card.getAttribute("aria-expanded")) !== "true") await card.click();
    await page.getByTestId("subagent-transcript").first().waitFor();

    return;
  }

  const hover = scene === "background-hover";

  const target = page.locator(
    hover ? '[data-testid="waiting"] button' : '[data-session-row][aria-current="true"]'
  );

  // A theme or density change can swallow the open; leave and come back until it shows.
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await target.hover();

    const shown = await page
      .getByTestId(hover ? "waiting-card" : "background-tasks")
      .waitFor({ timeout: 2000 })
      .then(() => true)
      .catch(() => false);

    if (shown) return;
  }
};

const TRANSCRIPT_SHOTS = new Set(["image", "command-open", "context"]);

/** T-ITEMS' shots: an image a tool showed, a command opened whole, the Session context card. */
const openTranscriptShot = async (page: Page, scene: string) => {
  if (scene === "image") {
    await page.getByTestId("image-link").first().click();
    await page.getByTestId("image-viewer").locator("img").waitFor();
  } else if (scene === "command-open") {
    const line = page.locator('[data-testid="command"] > button').first();

    if ((await line.getAttribute("aria-expanded")) !== "true") await line.click();
    await page.getByTestId("command-text").first().hover();
  } else {
    await page.mouse.move(0, 0);
    await page.getByTestId("session-context").click();
    await page.getByTestId("context-card").waitFor();
  }
};

/** Opens what a shot shows, again after each theme or density change closes it. */
const open = async (page: Page, scene: string) => {
  // Close what's open first; esc elsewhere would leave the new-session page.
  if ((await page.locator('[role="dialog"], [role="menu"]').count()) > 0) {
    await page.keyboard.press("Escape");
    await page.locator('[role="dialog"], [role="menu"]').first().waitFor({ state: "detached" });
  }

  if (scene === "picker") {
    await page.getByTestId("model-picker").first().click();
    await page.getByTestId("plan-limits").waitFor();
  } else if (scene === "availability") {
    await page.getByTestId("other-harnesses").first().click();
    await page.getByTestId("availability-sheet").waitFor();
  } else if (scene === "commands" || scene === "chip") {
    const input = page.locator('[data-testid="composer-input"]:visible');

    await input.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(scene === "commands" ? "/s" : "/simplify the parser, keep its API");
    await (scene === "commands"
      ? page.getByTestId("command-menu").waitFor()
      : page.locator(".composer-chip").first().waitFor());
  } else if (scene.startsWith("subagent-")) {
    await openSubagent(page, scene);
  } else if (scene.startsWith("background-")) {
    await openBackground(page, scene);
  } else if (POLARIS_OPEN.has(scene)) {
    await openPolaris(page, scene);
  } else if (TRANSCRIPT_SHOTS.has(scene)) {
    await openTranscriptShot(page, scene);
  } else if (scene === "jump") {
    await scrollAway(page);
  } else if (scene === "windows-hover") {
    await hoverUpgradedHost(page);
  } else if (scene === "viewer") {
    await page.locator('[data-testid="sent-image"][data-state="ready"]').first().click();
    await page.getByTestId("attachment-viewer").locator("img").waitFor();
  }
};

const densities = (option("--densities") ?? "calm,balanced,compact").split(",");

/** "dark" keeps the dark the settings hold; "moonlit" and "midnight" choose it. */
const themes = (option("--themes") ?? "dark,light").split(",");

const [width = 1440, height = 900] = (option("--size") ?? "1440x900").split("x").map(Number);

const setTheme = (theme: string) =>
  theme === "moonlit" || theme === "midnight"
    ? `Promise.all([window.polaris.request("settings.setTheme", { theme: "dark" }), window.polaris.request("settings.setAppearance", { patch: { darkTheme: "${theme}" } })])`
    : `window.polaris.request("settings.setTheme", { theme: "${theme}" })`;

/** The open card's bottom edge: a popover must stay 12px clear of the window (rule/popover-fits-window). */
const cardBottom = `(() => { const card = document.querySelector('[data-slot="instrument-card"]'); return card === null ? null : Math.round(card.getBoundingClientRect().bottom); })()`;

const home = mkdtempSync(join(tmpdir(), "polaris-screens-"));

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
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

  await page.setViewportSize({ width, height });
  mkdirSync(out, { recursive: true });

  if (args.includes("--frames")) {
    await page.evaluate(`location.hash = "#preview/long"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    await page.getByTestId("session-panel").waitFor();
    await page.waitForTimeout(500);

    const { times, height } = await page.evaluate<{ times: ReadonlyArray<number>; height: number }>(
      scrollFrames
    );

    console.log(`screens: scroll frames ${JSON.stringify({ ...frameStats(times), height })}`);
  }

  for (const scene of scenes) {
    // Shots that open something: the chip's menu on the session, the availability sheet.
    const base = SHOT_SCENES.get(scene) ?? scene;

    await page.evaluate(`location.hash = "#preview/${base}"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    const isNew = ["new", "setup", "none-ready"].includes(base);

    const ready = base.startsWith("usage-")
      ? "plan-meter"
      : base === "no-host"
        ? "no-host-stage"
        : isNew
          ? "new-session"
          : "session-panel";

    await page.getByTestId(ready).first().waitFor();

    // The setup scene's Codex needs sign-in: choose it to show its setup line.
    if (scene === "setup") await page.getByTestId("harness-codex").click();

    for (const density of densities) {
      for (const theme of themes) {
        await page.evaluate(
          `Promise.all([${setTheme(theme)}, window.polaris.request("settings.setDensity", { density: "${density}" })])`
        );
        const shown = theme === "light" ? "light" : "dark";

        const dark =
          theme === "moonlit" || theme === "midnight" ? `[data-theme-dark="${theme}"]` : "";

        await page
          .locator(`html[data-theme="${shown}"]${dark}[data-density="${density}"]`)
          .waitFor({
            state: "attached",
          });
        await page.waitForTimeout(400);
        await open(page, scene);
        await page.waitForTimeout(200);
        const path = join(out, `${scene}-${theme}-${density}.png`);

        await page.screenshot({ path });
        const bottom = await page.evaluate<number | null>(cardBottom);

        console.log(
          `screens: ${path}${bottom === null ? "" : ` · card bottom ${bottom} of ${height}`}`
        );
      }
    }
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
