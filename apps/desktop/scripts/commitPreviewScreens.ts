/**
 * Settings → Editor's Commit messages card against a real Daemon and repository (ENG-624):
 * node apps/desktop/scripts/commitPreviewScreens.ts <out dir> (build first). The preview shows
 * the selected Workspace's last commit, read with `git.log`.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { APP_DIR, sizeWindow, stockElectronBinary } from "./lib/electron.ts";

const out = process.argv[2] ?? join(process.cwd(), "commit-preview-screens");

// A short path: the Daemon's Unix socket lives under it.
const profile = realpathSync(mkdtempSync("/tmp/pcp-"));

const userData = join(profile, "user-data");

const repo = join(profile, "repo");

const SUBJECT = "feat(daemon): git.log answers the newest commits";

const BODY = "Settings previews a draft from the workspace's last commit, read without hooks.";

const git = (...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.com", ...args], {
    cwd: repo,
  });

mkdirSync(out, { recursive: true });

mkdirSync(userData);

mkdirSync(repo);

git("init", "-q", "-b", "main");

writeFileSync(join(repo, "README.md"), "# Repo\n");

git("add", "README.md");

git("commit", "-q", "-m", `${SUBJECT}\n\n${BODY}`);

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({ home: profile, benchHarness: true });
  app = await electron.launch({
    executablePath: stockElectronBinary(),
    args: ["--use-mock-keychain", APP_DIR],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "repo" } })`
  );
  await page.getByText("repo", { exact: true }).first().waitFor({ timeout: 15_000 });
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings.open")?.click();
  });
  await page.getByTestId("settings").waitFor({ timeout: 5_000 });
  await page.getByTestId("settings").getByRole("button", { name: "Editor", exact: true }).click();

  const preview = page.getByTestId("commit-preview");

  await preview.getByText(SUBJECT).waitFor({ timeout: 15_000 });
  assert.match(await preview.innerText(), /Like your last commit/i);
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, "editor-commit-preview.png") });

  const card = await preview.boundingBox();

  assert.ok(card !== null, "the preview is laid out");
  await page.screenshot({
    path: join(out, "commit-preview-card.png"),
    clip: { x: card.x - 24, y: card.y - 80, width: card.width + 48, height: card.height + 180 },
  });
  console.log(`commit-preview: the card shows "${SUBJECT}"; screenshots in ${out}`);
} finally {
  await app?.close();
  await daemon?.stop();
  rmSync(profile, { recursive: true, force: true });
}
