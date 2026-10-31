#!/usr/bin/env node
/**
 * This Mac's installed Daemon predates `harness.commands`: the app on a dev
 * build upgrades it on connection, the `/` menu says what is going on (here a
 * first upgrade fails, so "Try again"), and once upgraded the list arrives.
 * CI or a disposable VM only on macOS (launchd shares the real Daemon's label). All
 * in a temporary home; the old Daemon runs from a checkout of an older commit.
 *
 *   POLARIS_DESKTOP_SCRIPTED_LOCAL_INSTALL=1 node scripts/oldDaemon.ts --old <repo checked out before harness.commands> [--shots <dir>]
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { hostPlatform, standInPolaris, writeDist } from "../src/main/machines/fakeHost.testing.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  scriptedLocalInstall,
} from "./lib/electron.ts";

const args = process.argv.slice(2);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const old = option("--old");

if (old === null) throw new Error("--old <repo> is required");

const shots = option("--shots");

const repo = join(APP_DIR, "../..");

const platform = hostPlatform();

const root = mkdtempSync(join(tmpdir(), "polaris-old-daemon-"));

const home = join(root, "home");

const installEnv = scriptedLocalInstall(home);

const polaris = join(home, ".polaris");

const dist = join(root, "dist");

const OLD = "0.0.0-dev.399.bcc2f38";

const NEW = "0.0.0-dev.900.e2e0000";

const log = (m: string) => console.log(`old-daemon: ${m}`);

const env = { PATH: process.env.PATH, HOME: home, POLARIS_BENCH_HARNESS: "1" };

// The old Daemon, installed as the system one would be, and running.
mkdirSync(join(root, "v1"), { recursive: true });

writeFileSync(
  join(root, "v1/polaris"),
  standInPolaris({ version: OLD, platform, daemon: ["bun", join(old, "apps/daemon/src/main.ts")] })
);

chmodSync(join(root, "v1/polaris"), 0o755);

mkdirSync(home, { recursive: true });

spawnSync(join(root, "v1/polaris"), ["install"], { env });

if (!existsSync(join(polaris, "daemon.sock"))) throw new Error("the old Daemon didn't start");
// The app's bundled dev build: the current Daemon.

writeDist(dist, { version: NEW, platform, daemon: ["bun", join(repo, "apps/daemon/src/main.ts")] });
// The first upgrade fails: nothing can be uploaded into ~/.polaris.

chmodSync(polaris, 0o555);

log(`old Daemon ${OLD} running in ${home}`);

mkdirSync(join(root, "user-data"), { recursive: true });

writeFileSync(
  join(root, "user-data/settings.json"),
  JSON.stringify({ welcomeSeen: true, theme: "dark" })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: join(polaris, "daemon.sock"),
    ...installEnv,
    POLARIS_DESKTOP_DAEMON_DIST: dist,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: join(root, "user-data"),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const shoot = async (page: Page, name: string) => {
  if (shots === null) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

let failed = false;

const page = await app.firstWindow();

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  // A new session's composer, on This Mac (its home folder).
  await page.getByRole("button", { name: "Start session" }).click({ timeout: 30_000 });
  await page.getByTestId("new-session").waitFor({ timeout: 30_000 });
  const input = page.locator('[data-testid="composer-input"]:visible');
  const notice = page.getByTestId("command-notice");

  await input.click();
  await page.keyboard.type("/");
  await notice.filter({ hasText: "Couldn't upgrade the daemon on" }).waitFor({ timeout: 30_000 });
  log(`notice: ${await notice.innerText()}`);
  await shoot(page, "notice-failed");

  // Fixed: ↵ on the notice runs the upgrade again.
  chmodSync(polaris, 0o755);
  await page.keyboard.press("Enter");
  await page.getByText("Daemon upgraded", { exact: true }).waitFor({ timeout: 60_000 });
  log("toast: Daemon upgraded");
  await shoot(page, "upgraded");
  const version = spawnSync(join(polaris, "bin/current/polaris"), ["version"], { env });

  log(`installed now: ${version.stdout.toString().trim()}`);
  await page.getByTestId("command-menu").waitFor({ timeout: 60_000 });
  const listed = await page.getByTestId("command-menu").innerText();

  if (!listed.includes("compact")) throw new Error(`the list reads: ${listed}`);
  log("after the upgrade, / lists the Harness's commands");
  await shoot(page, "listed");
} catch (error) {
  failed = true;
  console.error("old-daemon: FAILED", error);
  await shoot(page, "failure");
} finally {
  await app.close();
  const pid = join(polaris, "stand-in.pid");

  if (existsSync(pid)) spawnSync("kill", [readFileSync(pid, "utf8").trim()]);
  chmodSync(polaris, 0o755);
  rmSync(root, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
