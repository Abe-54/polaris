#!/usr/bin/env node
/**
 * The first switch to each lazy mode on a cold start (ENG-905): Edit, Data, Traces, Requests,
 * and Review with an agent session open. The mode chunks are held back `--delay` ms, so the
 * wait is visible; a frame `--at` ms after each switch, and one once the mode has drawn.
 * `--warm` waits for the background warm-up first. Needs a built app.
 *
 *   node scripts/modeSwitchScreens.ts --out <dir> [--label before] [--delay 1500] [--at 120] [--warm]
 *     [--modes edit,data,traces,requests,review]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { seedSource } from "./lib/seed.ts";

const args = process.argv.slice(2);

const flag = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);

  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

const out = flag("out", "");

if (out === "") throw new Error("usage: node scripts/modeSwitchScreens.ts --out <dir> [--label x]");

const label = flag("label", "run");

const delay = Number(flag("delay", "1500"));

const frameAt = Number(flag("at", "120"));

const warm = args.includes("--warm");

const only = new Set(flag("modes", "edit,data,traces,requests,review").split(","));

mkdirSync(out, { recursive: true });

// A short path: the Daemon's Unix socket lives under it.
const home = mkdtempSync("/tmp/pms-");

const daemon = await startDaemon({ home: join(home, "local"), benchHarness: true });

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", welcomeSeen: true })
);

const CHUNK = /\/assets\/(DataMode|TracesMode|RequestsMode|EditMode|ReviewView)-[^/]*\.js$/;

const app = await electron.launch({
  executablePath: electronBinary(),
  args: ["--use-mock-keychain", APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const fetched: Array<{ chunk: string; at: number }> = [];

const started = Date.now();

await app.context().route(CHUNK, async (route) => {
  fetched.push({ chunk: new URL(route.request().url()).pathname, at: Date.now() - started });
  await new Promise((resolve) => setTimeout(resolve, delay));
  await route.continue();
});

const MODES = [
  { key: "Meta+3", mode: "edit", ready: "edit-mode" },
  { key: "Meta+4", mode: "data", ready: "data-mode" },
  { key: "Meta+5", mode: "traces", ready: "traces-mode" },
  { key: "Meta+6", mode: "requests", ready: "requests-mode" },
] as const;

const shoot = (page: Page, name: string) =>
  page.screenshot({ path: join(out, `${label}-${name}.png`) });

const timings: Record<string, number> = {};

/** Switch, a frame `frameAt` ms in, then the time until `ready` is on screen. */
const firstSwitch = async (page: Page, name: string, act: () => Promise<void>, ready: string) => {
  const t0 = Date.now();

  await act();
  await page.waitForTimeout(frameAt);
  await shoot(page, `${name}-wait`);
  await page.getByTestId(ready).first().waitFor({ timeout: 20_000 });
  timings[name] = Date.now() - t0;
  await page.waitForTimeout(300);
  await shoot(page, `${name}-ready`);
};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    seedSource([
      {
        hostKey: "local",
        name: "ledger",
        sessions: [{ title: "Fix overdue totals", state: "idle" }],
      },
    ])
  );
  await page.locator('[data-slot="chip"]', { hasText: "ledger" }).first().click();
  await page.getByText("Fix overdue totals", { exact: true }).first().click();
  await page.mouse.move(1300, 860);

  // Warm-up runs at idle; with the chunks held back it lands `delay` ms after it starts.
  if (warm) await page.waitForTimeout(delay * 6 + 2000);

  for (const { key, mode, ready } of MODES.filter((m) => only.has(m.mode))) {
    await firstSwitch(page, mode, () => page.keyboard.press(key), ready);
    await page.keyboard.press("Meta+1");
    await page.waitForTimeout(200);
  }

  // Review: the pull request list is in the main chunk; the view of a subject is not.
  if (only.has("review")) {
    await page.keyboard.press("Meta+2");
    await page.waitForTimeout(400);
    await shoot(page, "review-list");
    await firstSwitch(
      page,
      "review",
      () => page.getByText("Fix overdue totals", { exact: true }).first().click(),
      "review-view"
    );
  }

  const report = { label, delay, frameAt, warm, timings, fetched };

  writeFileSync(join(out, `${label}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
