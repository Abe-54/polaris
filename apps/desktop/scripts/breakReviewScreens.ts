#!/usr/bin/env node
/**
 * The break-UI pass (ENG-499) on Review and the constellation glance: `#review/worst…`
 * (review/preview/worstScenes.ts) and `#constellation/worst-…` (constellation/preview/worst.ts),
 * with the Stack popover, the folded Lead's wave bar and the Space peek open.
 *
 *   node scripts/breakReviewScreens.ts --out <dir> [--build] [--only review|constellation]
 *     [--themes moonlit,midnight,light] [--sizes 1440x900,1280x720]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Page } from "playwright-core";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";
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

const THEMES = [
  { name: "moonlit", theme: "dark", dark: null },
  { name: "midnight", theme: "dark", dark: "midnight" },
  { name: "light", theme: "light", dark: null },
] as const;

const themes = (option("--themes") ?? "moonlit,midnight,light").split(",");

const sizes = (option("--sizes") ?? "1440x900,1280x720").split(",").map((size) => {
  const [width = 1440, height = 900] = size.split("x").map(Number);

  return { width, height };
});

type Open = "stack-chip" | "peek" | null;

interface State {
  readonly name: string;
  readonly hash: string;
  readonly ready: string;
  readonly open: Open;
}

const REVIEW: ReadonlyArray<State> = [
  { name: "review-worst", hash: "#review/worst", ready: "risk-finding", open: null },
  { name: "review-worst-stack", hash: "#review/worst", ready: "stack-chip", open: "stack-chip" },
  {
    name: "review-merged-stack",
    hash: "#review/worst-merged",
    ready: "stack-chip",
    open: "stack-chip",
  },
  { name: "review-chat", hash: "#review/worst-chat", ready: "reviewer-asks", open: null },
  { name: "review-empty", hash: "#review/worst-empty", ready: "stack-chip", open: null },
  { name: "review-offline", hash: "#review/worst-offline", ready: "risk-finding", open: null },
];

const CONSTELLATION: ReadonlyArray<State> = [
  "worst-one",
  "worst-80",
  "worst-failed",
  "worst-accepted",
  "worst-cycle",
].flatMap((scene) => [
  {
    name: `constellation-${scene}`,
    hash: `#constellation/${scene}`,
    ready: "lead-group",
    open: null,
  },
  {
    name: `peek-${scene}`,
    hash: `#constellation/${scene}`,
    ready: "lead-group",
    open: "peek" as const,
  },
]);

const only = option("--only");

const states = [
  ...(only === "constellation" ? [] : REVIEW),
  ...(only === "review" ? [] : CONSTELLATION),
];

const home = mkdtempSync("/tmp/pbr-");

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const appearance = async (page: Page, theme: string, dark: string | null) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.evaluate(
    dark === null
      ? `delete document.documentElement.dataset.themeDark`
      : `document.documentElement.dataset.themeDark = "${dark}"`
  );
  await page.waitForTimeout(400);
};

/** Folds the Lead (so its row shows the wave bar), then for the peek presses Space on it. */
const openLead = async (page: Page, state: State, peek: boolean) => {
  const row = page.getByTestId("lead-group").first().locator("[aria-expanded]").first();

  await row.scrollIntoViewIfNeeded();
  await row.focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByTestId("wave-bar").first().waitFor({ timeout: 5000 });
  await page
    .getByTestId("lead-group")
    .first()
    .screenshot({ path: `${out}/${state.name}-row.png` });

  if (!peek) return;
  await page.keyboard.press("Space");
  await page.getByTestId("constellation-peek").waitFor();
};

try {
  const page = await app.firstWindow();

  mkdirSync(out, { recursive: true });

  for (const size of sizes) {
    await page.setViewportSize(size);

    for (const state of states) {
      for (const { name, theme, dark } of THEMES.filter((t) => themes.includes(t.name))) {
        await page.evaluate(`location.hash = "${state.hash}"; location.reload()`);
        await page.waitForLoadState("domcontentloaded");
        await page.getByTestId(state.ready).first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(1000);
        await appearance(page, theme, dark);

        if (state.hash.startsWith("#constellation"))
          await openLead(page, state, state.open === "peek");
        else if (state.open !== null) await page.getByTestId(state.open).first().click();
        await page.waitForTimeout(400);
        const path = join(out, `${state.name}-${name}-${size.width}.png`);

        await page.screenshot({ path });
        console.log(`screens: ${path}`);
      }
    }
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
