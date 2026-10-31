#!/usr/bin/env node
/**
 * ENG-209 check: a test Daemon reading this Mac's real Harness logs (real HOME),
 * a bench Turn streaming, then the Harness chip menu and Settings → Usage.
 * Measures renderer frames and round trips to main and to the Daemon. Needs a built app.
 *
 *   node scripts/usageUnderLoad.ts <screenshot dir>
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { frameStats } from "./lib/sessionFlow.ts";

const out = process.argv[2] ?? tmpdir();

const log = (m: string) => console.log(`freeze-check: ${m}`);

const home = mkdtempSync(join(tmpdir(), "polaris-freeze-"));

const t0 = Date.now();

const daemon = await startDaemon({ home, benchHarness: true, userHome: homedir() });

log(`Daemon up (real HOME ${homedir()}) in ${Date.now() - t0} ms`);

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ welcomeSeen: true, theme: "dark" })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const pct = (xs: Array<number>, q: number) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
};

/** Round trips every 100 ms for `ms`: `settings.get` (main) and `files.stat` (the Daemon). */
const roundTrips = (page: Page, ms: number) =>
  page.evaluate<{ main: Array<number>; daemon: Array<number>; failed: number }>(`(async () => {
    const main = [], daemon = []; let failed = 0;
    const end = performance.now() + ${ms};
    while (performance.now() < end) {
      let t = performance.now();
      await window.polaris.request("settings.get", {});
      main.push(performance.now() - t);
      t = performance.now();
      const r = await window.polaris.request("files.stat", { hostKey: "local", path: "/" });
      if (!r.ok) failed++;
      daemon.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 100));
    }
    return { main, daemon, failed };
  })()`);

const frames = (page: Page, ms: number) =>
  page.evaluate<ReadonlyArray<number>>(`new Promise((resolve) => {
    const times = []; const end = performance.now() + ${ms};
    const tick = (t) => { times.push(t); if (t < end) requestAnimationFrame(tick); else resolve(times); };
    requestAnimationFrame(tick);
  })`);

try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: null });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 30_000 });
  log("local Host connected");

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("dev-proof")?.click();
  });
  await page.getByTestId("session-panel").waitFor({ timeout: 30_000 });
  await page.getByTestId("session-state").filter({ hasText: /^Idle/ }).waitFor({ timeout: 90_000 });
  log("proof session idle; sending a long streaming Turn");

  const input = page.getByTestId("composer-input");
  await input.click();
  await input.fill('bench:{"items":30,"deltasPerItem":100,"deltaBytes":64,"deltaIntervalMs":10}');
  await page.keyboard.press("Enter");
  await page
    .getByTestId("session-state")
    .filter({ hasText: /^Working/ })
    .waitFor({ timeout: 15_000 });
  log("streaming");

  const WINDOW = 14_000;
  const marks: Array<{ step: string; at: number }> = [];

  const mark = async (step: string) =>
    marks.push({ step, at: await page.evaluate<number>("performance.now()") });

  const sampling = Promise.all([frames(page, WINDOW), roundTrips(page, WINDOW)]);

  const script = (async () => {
    await page.waitForTimeout(1_000);
    const opened = performance.now();
    await mark("chip click");
    await page.getByTestId("model-picker").first().click();
    await page.locator('[role="menu"]').first().waitFor({ timeout: 10_000 });
    log(`Harness chip menu open in ${(performance.now() - opened).toFixed(0)} ms`);
    await page.screenshot({ path: join(out, "chip-menu-while-streaming.png") });
    await page.waitForTimeout(2_000);
    await page.keyboard.press("Escape");
    await mark("settings open");
    const settingsAt = performance.now();
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("settings.open")?.click();
    });
    await page.getByTestId("settings").waitFor({ timeout: 10_000 });
    await mark("usage click");
    await page.getByRole("button", { name: "Usage" }).click();
    await page.locator('[data-section="usage"]').waitFor({ timeout: 10_000 });
    log(`Settings → Usage open in ${(performance.now() - settingsAt).toFixed(0)} ms`);
    await page.waitForTimeout(1_500);
    const indexing = await page.getByTestId("usage-indexing").count();
    log(`indexing caption shown: ${indexing > 0}`);
    await page.screenshot({ path: join(out, "usage-while-streaming.png") });
  })();

  const [[times, trips]] = await Promise.all([sampling, script]);
  log(`frames: ${JSON.stringify(frameStats(times))}`);

  const long = times.slice(1).flatMap((t, i) => {
    const gap = t - (times[i] ?? t);

    return gap > 50 ? [`${gap.toFixed(0)} ms at ${(t - (times[0] ?? t)).toFixed(0)} ms`] : [];
  });

  log(`frames over 50 ms: ${long.length === 0 ? "none" : long.join(", ")}`);
  log(
    `marks: ${JSON.stringify(marks.map((m) => ({ ...m, at: Math.round(m.at - (times[0] ?? 0)) })))}`
  );
  log(
    `main round trips (${trips.main.length}): p50 ${pct(trips.main, 0.5).toFixed(1)} ms, p95 ${pct(trips.main, 0.95).toFixed(1)} ms, max ${Math.max(...trips.main).toFixed(1)} ms`
  );
  log(
    `Daemon round trips (${trips.daemon.length}): p50 ${pct(trips.daemon, 0.5).toFixed(1)} ms, p95 ${pct(trips.daemon, 0.95).toFixed(1)} ms, max ${Math.max(...trips.daemon).toFixed(1)} ms, failed ${trips.failed}`
  );

  // Let the long pass finish, then Usage should re-query and fill in.
  const done = await page
    .getByTestId("usage-indexing")
    .waitFor({ state: "detached", timeout: 240_000 })
    .then(
      () => true,
      () => false
    );

  log(`indexing finished within 4 min: ${done}`);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: join(out, "usage-after-indexing.png") });
  const text = await page.locator('[data-section="usage"]').innerText();
  log(`Usage after indexing: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
