#!/usr/bin/env node
/**
 * Same-prompt smoke: in one git Workspace, two sessions with the same prompt
 * start in place (the default) and share the directory; then, with Settings'
 * "Start on a new worktree" on, two more get two distinct Worktrees.
 *
 *   node scripts/samePrompt.ts [--build] [--show] [--screenshots <dir>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { initRepo } from "./lib/sessionFlow.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--screenshots");

const screenshots = at === -1 ? null : (args[at + 1] ?? null);

const PROMPT = "Fix the flaky test";

const step = (message: string) => console.log(`same-prompt: ${message}`);

if (args.includes("--build")) {
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });
}

const home = mkdtempSync(join(tmpdir(), "polaris-same-prompt-"));

const userData = join(home, "user-data");

const repo = join(home, "repo");

mkdirSync(userData, { recursive: true });

initRepo(repo);

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const daemon = await startDaemon({ home, benchHarness: true });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: args.includes("--show") ? "0" : "1",
  },
});

const shoot = async (page: Page, name: string) => {
  if (screenshots === null) return;
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `${name}.png`) });
  step(`saved ${name}.png`);
};

/** The branches of the repo's Worktrees other than the main checkout. */
const worktreeBranches = () =>
  execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((l) => l.startsWith("branch refs/heads/"))
    .map((l) => l.slice("branch refs/heads/".length))
    .filter((b) => b !== "main");

/** Opens New session, checks the where line, and starts a session with the same prompt. */
const startOne = async (page: Page, where: RegExp, shot: string | null) => {
  await page.getByRole("button", { name: "New session" }).first().click();
  await page.getByTestId("new-session").waitFor();
  const line = page.getByTestId("where-line");

  await line.filter({ hasText: where }).waitFor({ timeout: 5000 });
  step(`where line: ${(await line.textContent())?.trim()}`);
  await page
    .locator('[role="radiogroup"][aria-label="Harness"] [aria-checked="true"]')
    .waitFor({ timeout: 10_000 });
  await page.getByTestId("composer-input").fill(PROMPT);

  if (shot !== null) await shoot(page, shot);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByTestId("session-panel").waitFor({ timeout: 15_000 });
};

/** Waits for at least `n` session rows in the sidebar; false if they never show. */
const sessionRows = (page: Page, n: number) =>
  page
    .getByTestId("row-state")
    .nth(n - 1)
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false
    );

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1280, 800);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 15_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "same-repo" } })`
  );
  await page
    .getByRole("button", { name: /same-repo/ })
    .first()
    .click();

  await startOne(page, /, in place\.$/, "in-place-first");
  await startOne(page, /in place alongside 1 other session\.$/, "in-place-second");

  if (!(await sessionRows(page, 2))) throw new Error("expected two sessions in the sidebar");

  if (worktreeBranches().length !== 0) throw new Error("an in-place session created a worktree");
  step("two sessions with the same prompt run in the workspace directory");

  await page.keyboard.press("Meta+Comma");
  await page.getByRole("button", { name: "Sessions" }).first().click();
  await page.locator("#new-worktree").click();
  await page.locator('#new-worktree[data-state="checked"]').waitFor({ timeout: 5000 });
  await shoot(page, "settings-new-worktree");
  await page.keyboard.press("Escape");
  step("Settings: new sessions start on a new worktree");

  await startOne(page, /on a new worktree from main\.$/, "worktree-first");
  await startOne(page, /on a new worktree from main\.$/, null);

  for (let i = 0; i < 50 && worktreeBranches().length < 2; i++) await page.waitForTimeout(100);
  const branches = worktreeBranches();

  step(`worktree branches: ${branches.join(", ")}`);

  if (branches.length !== 2 || branches[0] === branches[1])
    throw new Error("the same prompt should get two distinct worktrees");

  if (!(await sessionRows(page, 4))) throw new Error("expected four sessions in the sidebar");
  step("ok");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
