#!/usr/bin/env node
/**
 * An Agent Session's Review after real use (UB diffview 1), on the built app and a real
 * Daemon on the bench Harness: three Turns that change one file, other commits moving HEAD
 * between them, a Daemon restart (the session goes dormant), then the session in Review.
 *
 *   node scripts/reviewSession.ts [--build] [--shot <png>]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import {
  checkSessionReview,
  checkTurnPicker,
  initSessionRepo,
  runSessionTurns,
} from "./lib/sessionReviewFlow.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--shot");

const shot = at === -1 ? null : (args[at + 1] ?? null);

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const home = mkdtempSync(join(tmpdir(), "polaris-review-session-"));

const repo = join(home, "repo");

initSessionRepo(repo);

let daemon = await startDaemon({ home, benchHarness: true });

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

const errors: Array<string> = [];

try {
  const page = await app.firstWindow();

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("radio", { name: /^Review/ }).waitFor();
  await runSessionTurns(page, repo);

  if (args.includes("--no-restart")) console.log("review-session: 3 Turns done");
  else {
    console.log("review-session: 3 Turns done; restarting the Daemon");
    await daemon.stop();
    daemon = await startDaemon({ home, benchHarness: true });
  }

  await checkSessionReview(page, (m) => console.log(`review-session: ${m}`));
  await checkTurnPicker(page, (m) => console.log(`review-session: ${m}`));

  if (shot !== null) await page.screenshot({ path: shot });
} catch (cause) {
  const page = await app.firstWindow();

  if (shot !== null) await page.screenshot({ path: shot });

  console.log(`review-session: FAILED ${String(cause)}\nrenderer errors:\n${errors.join("\n")}`);
  process.exitCode = 1;
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
