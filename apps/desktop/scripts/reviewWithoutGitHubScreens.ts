#!/usr/bin/env node
/**
 * Review without GitHub, against a real Daemon: an Agent Session's Turns stay reviewable while
 * nobody is signed in, and while GitHub (the fake, stopped) can't be reached. Both themes.
 *
 *   node scripts/reviewWithoutGitHubScreens.ts --out <dir> [--build]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { MOCK_KEYCHAIN, serveGitHubFake } from "./lib/githubFlow.ts";
import { initRepo } from "./lib/sessionFlow.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("usage: node scripts/reviewWithoutGitHubScreens.ts --out <dir>");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-review-offline-"));

const repo = join(home, "code", "widgets");

initRepo(repo);

spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });

const daemon = await startDaemon({ home, benchHarness: true, userHome: home });

const github = await serveGitHubFake();

const userData = seenUserData(join(home, "user-data"));

const launch = () =>
  electron.launch({
    executablePath: electronBinary(),
    args: [APP_DIR, MOCK_KEYCHAIN],
    env: {
      ...process.env,
      ...github.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: "1",
    },
  });

const TURN = `bench:${JSON.stringify({ items: 3, deltasPerItem: 2, deltaIntervalMs: 1, touchFiles: 2 })}`;

const startSource = `(async () => {
  const api = window.polaris;
  const must = (r, what) => { if (!r.ok) throw new Error(what + ": " + r.error.message); return r.value; };
  const dispatch = (command) =>
    api.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command }).then((r) => must(r, command._tag));
  await dispatch({ _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "widgets" });
  const workspaceId = await new Promise((resolve) => {
    const close = api.subscribe("host", { hostKey: "local" }, { items: (items) => {
      for (const i of items) {
        const all = i._tag === "Snapshot" ? i.workspaces
          : i._tag === "Event" && i.envelope.event._tag === "WorkspaceRegistered" ? [i.envelope.event.workspace] : [];
        const found = all.find((w) => w.path === ${JSON.stringify(repo)});
        if (found) { close(); resolve(found.id); return; }
      }
    } });
  });
  const sessionId = crypto.randomUUID();
  await dispatch({ _tag: "StartSession", sessionId, workspaceId, harness: "codex",
    placement: { _tag: "InPlace" }, permissionMode: "auto", model: null, effort: null,
    prompt: ${JSON.stringify(TURN)}, attachments: [] });
  await dispatch({ _tag: "RenameSession", sessionId, title: "Cap webhook retries" });
})()`;

const appearance = async (page: Page, theme: "dark" | "light") => {
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);
  await page.evaluate(`window.polaris.request("settings.setDensity", { density: "calm" })`);
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(400);
};

const shoot = async (page: Page, name: string) => {
  for (const theme of ["dark", "light"] as const) {
    await appearance(page, theme);
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
  }

  await appearance(page, "dark");
  console.log(`screens: ${name}`);
};

const ready = (page: Page) =>
  page
    .getByTestId("pulls-group-sessions")
    .getByText("Cap webhook retries")
    .waitFor({ timeout: 20_000 });

const notice = async (page: Page, kind: string) => {
  const row = page.locator(`[data-testid="pulls-notice"][data-kind="${kind}"]`);

  await row.waitFor({ timeout: 20_000 });
  console.log(`notice ${kind}: ${await row.textContent()}`);
};

const firstWindow = async (app: ElectronApplication) => {
  const page = await app.firstWindow();

  page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
  await sizeWindow(app, 1440, 900);
  await page.getByRole("radio", { name: /^Review/ }).waitFor({ timeout: 15_000 });

  return page;
};

const toReview = (page: Page) => page.getByRole("radio", { name: /^Review/ }).click();

/** Signed out: the session is listed under a notice, and its Turns open in Review. */
const signedOut = async (page: Page) => {
  await page.evaluate(startSource);
  await toReview(page);
  await ready(page);
  await notice(page, "signed-out");
  await shoot(page, "signed-out-list");
  await page.getByTestId("pulls-group-sessions").getByText("Cap webhook retries").click();
  await page.getByTestId("review-view").locator("[data-review-item]").first().waitFor({
    state: "attached",
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);
  await shoot(page, "signed-out-session-review");
  await page.getByRole("button", { name: "Pull requests" }).click();
};

const signIn = async (page: Page) => {
  const started = await page.evaluate<{ userCode: string }>(
    `window.polaris.request("github.signIn.start", {}).then((r) => r.value)`
  );

  github.fake.approveDevice(started.userCode, "mona");
};

try {
  const first = await launch();

  try {
    const page = await firstWindow(first);

    await page
      .locator('[data-host="local"][data-connection="connected"]')
      .waitFor({ timeout: 15_000 });
    await signedOut(page);
    await signIn(page);
    await toReview(page);
    await page.getByTestId("pulls-group-requested").waitFor({ timeout: 20_000 });
    await shoot(page, "signed-in-list");

    // GitHub stops answering: the next poll fails and the list says so, sessions still there.
    await github.close();
    await page.evaluate(`window.polaris.request("github.refresh", {})`);
    await notice(page, "error");
    await ready(page);
    await shoot(page, "offline-list");
  } finally {
    await first.close();
  }

  // A fresh launch while GitHub is down: never answered, nothing waits on it.
  const second = await launch();

  try {
    const page = await firstWindow(second);

    await toReview(page);
    await ready(page);
    await page.locator('[data-testid="pulls-notice"]').first().waitFor({ timeout: 30_000 });
    console.log(
      `relaunch notices: ${(await page.locator('[data-testid="pulls-notice"]').allTextContents()).join(" | ")}`
    );
    await shoot(page, "offline-relaunch-list");
  } finally {
    await second.close();
  }
} finally {
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
