/**
 * "Write a message" in the real app against a bench Daemon: node apps/desktop/scripts/commitMessageSmoke.ts
 * (build first). In a git repo with one staged file, the Commit box's focus ring is whole in both themes
 * and all three densities; the button writes from the staged diff, Undo restores the user's text,
 * ⌥⌘G then Esc stops a slow Harness, a refusal shows under Commit, and nothing staged turns it off.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  stockElectronBinary,
} from "./lib/electron.ts";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "polaris-commit-message-")));

const userData = join(profile, "user-data");

const repo = join(profile, "repo");

const evidence = join(REPO_ROOT, ".dagr/evidence/commitmsg");

const git = (...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.com", ...args], {
    cwd: repo,
  });

mkdirSync(userData);

mkdirSync(repo);

mkdirSync(evidence, { recursive: true });

git("init", "-q", "-b", "main");

writeFileSync(join(repo, "README.md"), "# Repo\n");

git("add", "README.md");

git("commit", "-q", "-m", "docs: start the readme");

writeFileSync(join(repo, "notes.md"), "Staged notes\n");

writeFileSync(join(repo, "README.md"), "# Repo\n\nUnstaged edit.\n");

git("add", "notes.md");

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

const message = (page: Page) => page.getByTestId("commit-message").inputValue();

const setChoice = (page: Page, model: string) =>
  page.evaluate(
    `window.polaris.request("settings.setSessions", { patch: { commitMessages: { harness: "claude", model: ${JSON.stringify(model)}, effort: null } } })`
  );

/** The focus ring (2px, offset 2px) must sit inside the Changes tab's scroll area. */
const ringInside = async (page: Page) => {
  const field = await page.getByTestId("commit-field").boundingBox();
  const panel = await page.getByTestId("git-panel").boundingBox();

  assert.ok(field !== null && panel !== null, "Commit field and panel are laid out");

  return (
    field.y - 4 >= panel.y - 0.5 &&
    field.x - 4 >= panel.x - 0.5 &&
    field.x + field.width + 4 <= panel.x + panel.width + 0.5
  );
};

const appearance = async (page: Page, theme: string, density: string) => {
  await page.evaluate(
    `Promise.all([window.polaris.request("settings.setTheme", { theme: "${theme}" }), window.polaris.request("settings.setDensity", { density: "${density}" })])`
  );
  await page
    .locator(`html[data-theme="${theme}"][data-density="${density}"]`)
    .waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({ home: profile, benchHarness: true });
  app = await electron.launch({
    executablePath: stockElectronBinary(),
    args: [APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  page.on("pageerror", (error) => console.log(`smoke: page error: ${error.message}`));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "repo" } })`
  );
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 30_000 });
  await page
    .getByTestId("explorer")
    .getByText(/^Changes/)
    .first()
    .click();
  await page.getByTestId("commit-box").waitFor({ timeout: 15_000 });

  // 1. The focus ring is whole, in both themes and every density.
  for (const density of ["calm", "balanced", "compact"])
    for (const theme of ["dark", "light"]) {
      await appearance(page, theme, density);
      await page.getByTestId("commit-message").focus();
      assert.ok(await ringInside(page), `Focus ring clipped (${theme}, ${density})`);
      await page.screenshot({
        path: join(evidence, `focus-${theme}-${density}.png`),
        clip: { x: 0, y: 80, width: 280, height: 240 },
      });
    }

  console.log("smoke: focus ring whole in 2 themes × 3 densities");

  // 2. Writes from the staged diff, replacing the user's text with Undo.
  await setChoice(page, "claude-haiku-5-5");
  await page.getByTestId("commit-message").fill("wip");
  await page.getByTestId("commit-write").click();
  await until("a written message", async () => (await message(page)) === "Update notes.md");
  await page.getByTestId("commit-write-undo").waitFor();
  await page.screenshot({ path: join(evidence, "replaced-light.png") });
  await page.getByTestId("commit-write-undo").click();
  assert.equal(await message(page), "wip", "Undo restores the user's text");
  console.log("smoke: written, then undone");

  // 3. ⌥⌘G starts a slow Harness; Esc stops it and keeps the text.
  await setChoice(page, 'bench:{"delayMs":20000}');
  await page.getByTestId("commit-message").fill("mine");
  await page.keyboard.press("Meta+Alt+KeyG");
  await page.getByTestId("commit-write-stop").waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId("commit-button").isDisabled(), true, "Commit is off");
  await appearance(page, "dark", "calm");
  await page.screenshot({ path: join(evidence, "writing-dark.png") });
  await page.getByTestId("commit-message").focus();
  await page.keyboard.press("Escape");
  await page.getByTestId("commit-write-stop").waitFor({ state: "detached" });
  assert.equal(await message(page), "mine", "Stop keeps the user's text");
  console.log("smoke: ⌥⌘G then Esc");

  // 4. A refusal says why under Commit, and the message stays.
  await setChoice(page, 'bench:{"fail":"scripted failure"}');
  await page.getByTestId("commit-write").click();
  await page.getByTestId("commit-write-failed").waitFor({ timeout: 15_000 });
  assert.equal(await message(page), "mine", "A failure keeps the user's text");
  await page.screenshot({ path: join(evidence, "failed-dark.png") });
  console.log(`smoke: refused: ${await page.getByTestId("commit-write-failed").innerText()}`);

  // 5. Nothing staged turns the button off.
  await page.getByTestId("unstage-all").click();
  await until("nothing staged", () => page.getByTestId("commit-write").isDisabled());
  console.log("smoke: off with nothing staged");
  console.log(`smoke: passed; evidence in ${evidence}`);
} finally {
  await app?.close();
  await daemon?.stop();
  rmSync(profile, { recursive: true, force: true });
}
