#!/usr/bin/env node
/**
 * Opens every Review fixture scene (`#review/<scene>`) and the ask-the-reviewer round trip, and
 * fails on any page error, console error or blank window (ENG-757). Build first.
 *
 *   node scripts/reviewCrashSmoke.ts [--build] [--scenes xg,worst,…] [--open-only] [--theme light]
 *     [--screenshots <dir>]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

/** Every scene review/preview answers, the large and odd ones included. */
const SCENES = [
  "pull",
  "pull-verdict",
  "session",
  "session-ov",
  "stacked",
  "large",
  "list-only",
  "bench",
  "xg",
  "xg-chat",
  "worst",
  "worst-chat",
  "worst-empty",
  "worst-merged",
  "worst-offline",
  "merge-ready",
  "merge-blocked",
  "merge-blocked-header",
  "merge-auto",
  "merge-auto-on",
  "merge-done",
  "merge-kept",
  "merged",
  "queue-done",
  "session-data",
  "session-data-diff",
  "session-data-pending",
  "session-data-pruned",
  "session-data-worst",
  "session-data-unavailable",
  "session-data-unsupported",
  "session-traces",
  "session-traces-failed",
  "session-traces-list",
  "session-traces-new",
  "session-traces-worst",
  "session-traces-unsupported",
];

const scenes = option("--scenes")?.split(",") ?? SCENES;

/** `--open-only`: open each scene and wait, without asking the reviewer or going back. */
const interact = !args.includes("--open-only");

/** `--screenshots <dir>`: a screenshot of each pane that shows its error state. */
const shots = option("--screenshots");

const theme = option("--theme") ?? "dark";

const home = mkdtempSync("/tmp/prc-");

const userData = seenUserData(join(home, "user-data"));

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const failures: Array<string> = [];

const PLANTED = "review crash smoke: planted rejection";

/** @pierre/diffs logs hand-written fixture patches whose hunk headers miscount; not a crash. */
const IGNORED = [/parsePatchContent: hunk line count mismatch/, new RegExp(PLANTED)];

const fail = (text: string) => {
  if (!IGNORED.some((pattern) => pattern.test(text))) failures.push(text);
};

let current = "launch";

const blank = async (page: Page) => (await page.locator("#root > *").count()) === 0;

/** Asks the reviewer, then goes back to the findings: ENG-756's unmount. */
const askAndReturn = async (page: Page) => {
  const input = page.getByTestId("ask-input").first();

  if ((await input.count()) > 0 && (await input.isEnabled())) {
    await input.fill("Is this safe to merge?");
    await input.press("Enter");
    await page.waitForTimeout(800);
  }

  const back = page.getByTestId("risk-back-to-findings").first();

  if ((await back.count()) > 0) {
    await back.click();
    await page.waitForTimeout(500);
  }
};

try {
  const page = await app.firstWindow();

  page.on("pageerror", (error) => fail(`${current}: pageerror ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") fail(`${current}: console ${message.text()}`);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
  );

  for (const scene of scenes) {
    current = scene;
    await page.evaluate(`location.hash = "#review/${scene}"; location.reload()`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    if (interact && (scene.startsWith("xg") || scene.startsWith("worst"))) await askAndReturn(page);

    if (await blank(page)) fail(`${scene}: blank window`);

    if ((await page.getByTestId("pane-crashed").count()) > 0) {
      fail(`${scene}: a pane shows its error state`);

      if (shots !== null) await page.screenshot({ path: join(shots, `${scene}-crashed.png`) });
    }

    console.log(`review crash smoke: ${scene}`);
  }

  // The renderer's listeners, IPC and main's crash log, end to end.
  current = "crash log";
  await page.evaluate(`void Promise.reject(new Error("${PLANTED}"))`);
  await page.waitForTimeout(1000);

  const log = join(userData, "logs", "crashes.log");

  if (!existsSync(log) || !readFileSync(log, "utf8").includes(PLANTED)) {
    failures.push(`crash log: ${log} has no entry for the planted rejection`);
  }
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}

for (const failure of failures) console.error(failure);

console.log(`review crash smoke: ${scenes.length} scenes, ${failures.length} problems`);

process.exitCode = failures.length === 0 ? 0 : 1;
