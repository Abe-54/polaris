#!/usr/bin/env node
/**
 * Smoke test: starts a throwaway Daemon on the bench Harness, launches the
 * built app against it with a hidden window (Playwright's Electron support),
 * starts the proof session and asserts the screen shows it live, to the end.
 *
 *   node scripts/smoke.ts [--build] [--show] [--screenshots <dir>]
 *
 * Runs under Node: Playwright's Electron launcher does not connect under Bun.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { spawnSync } from "node:child_process";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  OUT_DIR,
  REPO_ROOT,
  sizeWindow,
} from "./lib/electron.ts";
import { probeSource } from "./lib/probe.ts";
import { startDaemon } from "./lib/daemon.ts";
import { freshStartFlow } from "./lib/freshStartFlow.ts";
import { machineFlow, prepareFakeHost } from "./lib/machineFlow.ts";
import { checkNoneReady, initRepo, sessionFlow } from "./lib/sessionFlow.ts";
import { constellationSetupFlow } from "./lib/constellationSetupFlow.ts";
import { remoteFlow } from "./lib/remoteFlow.ts";
import { settingsFlow } from "./lib/settingsFlow.ts";
import { attachmentsFlow } from "./lib/attachmentsFlow.ts";
import { extensionsFlow } from "./lib/extensionsFlow.ts";
import { composerFlow } from "./lib/composerFlow.ts";
import { editorLinksFlow } from "./lib/editorLinksFlow.ts";
import { imageAfterRelaunch, sendImage } from "./lib/previewFlow.ts";
import { reviewerFlow } from "./lib/reviewerFlow.ts";
import { reviewSettingsFlow } from "./lib/reviewSettingsFlow.ts";
import { runSubagent, subagentAfterRelaunch } from "./lib/subagentFlow.ts";
import { terminalFlow } from "./lib/terminalFlow.ts";
import { explorerFlow } from "./lib/explorerFlow.ts";
import {
  githubEnterpriseFlow,
  githubFlow,
  MOCK_KEYCHAIN,
  serveGitHubEnterpriseFake,
  serveGitHubFake,
} from "./lib/githubFlow.ts";
import { addRemotes, pullsFlow } from "./lib/pullsFlow.ts";
import { afterMerge, checkoutFlow, cloneFlow, setFakeHead } from "./lib/checkoutFlow.ts";
import { reviewFlow, setupCodeHost } from "./lib/reviewFlow.ts";
import {
  checkSessionReview,
  checkTurnPicker,
  initSessionRepo,
  runSessionTurns,
} from "./lib/sessionReviewFlow.ts";
import { findingsFlow } from "./lib/findingsFlow.ts";
import { acceptFlow } from "./lib/acceptFlow.ts";

import { takeScriptLease } from "../../../tooling/leases.ts";

await takeScriptLease("smoke");

const args = process.argv.slice(2);

const flag = (name: string) => args.includes(name);

const option = (name: string) => {
  const at = args.indexOf(name);

  return at === -1 ? null : (args[at + 1] ?? null);
};

const screenshots = option("--screenshots");

/** The renderer bundle: large enough that `files.read` sends it as a blob. */
const bigAsset = () => {
  const dir = join(OUT_DIR, "renderer/assets");
  // The largest chunk: lazy chunks (the session preview) are too small to be sent as blobs.

  const js = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, f))
    .toSorted((a, b) => statSync(b).size - statSync(a).size)[0];

  if (js === undefined) throw new Error("build the renderer first");

  return js;
};

const step = (message: string) => console.log(`smoke: ${message}`);

if (flag("--build")) {
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });
}

// First, its own launch: New session the moment the local Host connects (V2 bug 1).
await freshStartFlow({ step, show: flag("--show") });

// Then only a remote Host: ⌘O a folder there, New session, a Turn on the remote Host.
await remoteFlow({ step, show: flag("--show"), shots: screenshots });

const home = mkdtempSync(join(tmpdir(), "polaris-smoke-"));

const userData = join(home, "user-data");

// A fresh home for the Daemon too: onboarding registers it as the "home" Workspace.
const userHome = join(home, "user-home");

mkdirSync(userHome, { recursive: true });

// Claude Code's own spinnerVerbs, which the Working strip of a Claude Code session shows.
mkdirSync(join(userHome, ".claude"), { recursive: true });

writeFileSync(
  join(userHome, ".claude", "settings.json"),
  JSON.stringify({ spinnerVerbs: { mode: "replace", verbs: ["Flat out"] } })
);

const daemon = await startDaemon({ home, benchHarness: true, userHome });

const fakeHost = prepareFakeHost(join(home, "remote"));

const github = await serveGitHubFake();

const enterprise = await serveGitHubEnterpriseFake();

const UNREACHABLE = "polaris-smoke.invalid";

// A remote Host that can't be reached: it must show a Connection State, never block the app.
mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ hosts: [{ alias: UNREACHABLE, label: "Nowhere" }] })
);

step(`Daemon up at ${daemon.socketPath}`);

const launch = () =>
  electron.launch({
    executablePath: electronBinary(),
    args: [APP_DIR, MOCK_KEYCHAIN],
    env: {
      ...process.env,
      POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
      POLARIS_DESKTOP_BENCH_HARNESS: "1",
      POLARIS_DESKTOP_USER_DATA: userData,
      POLARIS_DESKTOP_HIDDEN: flag("--show") ? "0" : "1",
      ...fakeHost.env,
      ...github.env,
      ...enterprise.env,
    },
  });

let app = await launch();

const SWITCHES = 40;

/** ⌃1 / ⌃2 back and forth; input → second frame after it, per routes/switchTimer.ts. M1: < 100 ms. */
const timeSwitches = async (page: Page) => {
  for (let i = 0; i < SWITCHES; i++) {
    await page.keyboard.press(i % 2 === 0 ? "Control+Digit1" : "Control+Digit2");
    await page.waitForTimeout(40);
  }

  await page.waitForTimeout(200);
  // SAFETY: switchTimes() returns an array of numbers (routes/switchTimer.ts).
  const times = (await page.evaluate("window.__polaris.switchTimes()")) as Array<number>;
  const sorted = [...times].sort((a, b) => a - b);

  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;

  step(
    `Workspace switch (${sorted.length}): p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${at(1).toFixed(1)} ms`
  );

  if (sorted.length < SWITCHES / 2)
    throw new Error("the Workspace switch timer recorded too few switches");

  if (at(0.95) > 100) throw new Error("Workspace switch p95 is over the 100 ms budget");
};

/** ⌘K, type the other Workspace's name, ↵: its session opens (Sessions rank first); then ⌘/ help. */
const jumpByTyping = async (page: Page) => {
  // Not onboarding's "home": it has no session to open.
  const chip = page
    .locator('[data-slot="chip"][aria-pressed="false"]')
    .filter({ hasNotText: /^\s*home/ })
    .first();

  const name = ((await chip.textContent()) ?? "").replace(/\s*⌃\d.*$/, "").trim();

  await page.keyboard.press("Meta+K");
  const input = page.getByRole("combobox");

  await input.waitFor({ timeout: 5000 });
  await input.pressSequentially(name, { delay: 20 });
  await page.getByTestId("jump-item").first().waitFor();
  const first = (await page.getByTestId("jump-item").first().textContent()) ?? "";

  await page.keyboard.press("Enter");
  await page
    .locator('[data-slot="chip"][aria-pressed="true"]', { hasText: name })
    .waitFor({ timeout: 5000 });
  step(`jumped by typing "${name}" to: ${first.slice(0, 60)}`);

  await page.keyboard.press("Meta+Slash");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  // Closed at once (data-state), even while the fade-out still runs.
  await page
    .locator('[role="dialog"][data-state="open"]')
    .waitFor({ state: "detached", timeout: 5000 });
  step("shortcut help opens with ⌘/ and closes with esc");

  await page.keyboard.press("Meta+2");
  await page.getByTestId("pull-list").waitFor({ timeout: 5000 });
  await page.keyboard.press("Meta+1");
  await page.getByTestId("session-panel").waitFor({ timeout: 5000 });
  step("⌘2 and ⌘1 switch views");
};

/** Develop → Start proof session, as the menu does it. */
const startProof = () =>
  app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("dev-proof")?.click();
  });

const setTheme = async (page: Page, theme: "dark" | "light") => {
  // What View → Appearance does (menu.ts): the setting, then data-theme on the root.
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

/** Saves `<name>-dark.png` and `<name>-light.png`, then leaves the app dark. */
const shoot = async (page: Page, name: string) => {
  if (screenshots === null) return;
  mkdirSync(screenshots, { recursive: true });

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    const path = join(screenshots, `${name}-${theme}.png`);

    await page.screenshot({ path, mask: [page.getByTestId("pairing-reveal")] });
    step(`saved ${path}`);
  }

  await setTheme(page, "dark");
};

/** O1 Welcome → Get started → O2 setup → Start session → New session in "home". */
const onboarding = async (page: Page) => {
  await page.getByTestId("welcome").waitFor({ timeout: 15_000 });
  await page
    .getByTestId("found")
    .filter({ hasText: /Claude Code|Bench|No agents/ })
    .waitFor();
  step(`O1 welcome: ${await page.getByTestId("found").textContent()}`);
  await shoot(page, "o1-welcome");
  await page.keyboard.press("Enter");

  await page.getByTestId("setup-start-session").waitFor({ timeout: 15_000 });
  step("O2 setup: no Workspace on any Host");
  await shoot(page, "o2-setup");
  await page.getByTestId("setup-start-session").click();

  await page
    .getByTestId("new-session")
    .filter({ hasText: "New session · home" })
    .waitFor({ timeout: 15_000 });
  step(`New session in the home Workspace (${userHome})`);
  await shoot(page, "o2-home-new-session");
};

/** The main process's Needs You probe (src/main/notifications). */
const needsYouProbe = () =>
  app.evaluate(() => {
    const probe = globalThis.__polarisNeedsYou;

    return probe === undefined
      ? null
      : {
          count: probe.count(),
          tray: probe.trayTitle(),
          notified: probe.notified(),
          requests: [...probe.requests()],
          standing: [...probe.standing()],
        };
  });

interface Probe {
  readonly count: number;
  readonly tray: string;
  readonly notified: number;
  readonly requests: ReadonlyArray<string>;
  readonly standing: ReadonlyArray<{ readonly key: string; readonly requestId: string }>;
}

const waitForProbe = async (want: (p: Probe) => boolean, what: string) => {
  for (let i = 0; i < 50; i++) {
    const probe = await needsYouProbe();

    if (probe !== null && want(probe)) return probe;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Needs You: ${what} never happened (${JSON.stringify(await needsYouProbe())})`);
};

/** Presses a button on the notification for the next request not yet `answered`. */
const pressNotification = async (index: 0 | 1, answered: ReadonlyArray<string>) => {
  const probe = await waitForProbe(
    (p) => p.standing.some((n) => !answered.includes(n.requestId)),
    "a notification for the next request"
  );

  const shown = probe.standing.find((n) => !answered.includes(n.requestId))!;

  const pressed = await app.evaluate(
    (_electron, [key, button]) => globalThis.__polarisNeedsYou?.press(key, button) ?? false,
    [shown.key, index] as const
  );

  if (!pressed) throw new Error(`the notification for ${shown.requestId} has no buttons`);
  await waitForProbe((p) => !p.requests.includes(shown.requestId), "the notification's answer");

  return shown.requestId;
};

/**
 * The first approval: the menu bar count, then Approve on its notification; the second: Deny
 * on its notification; the third is approved from the inbox. Each leaves the summary.
 */
const inboxCheck = async (page: Page) => {
  const before = await waitForProbe(
    (p) => p.count > 0 && p.tray === String(p.count),
    "the tray count"
  );

  step(`menu bar star: ${before.tray} waiting; ${before.notified} notification(s) planned`);
  const approvedThere = await pressNotification(0, []);

  step(`approved ${approvedThere} from its notification; it left the menu bar summary`);
  const denied = await pressNotification(1, [approvedThere]);

  step(`denied ${denied} from its notification; the Turn went on`);
  await waitForProbe(
    (p) => p.requests.some((r) => r !== denied && r !== approvedThere),
    "a third request"
  );
  await page.getByRole("radio", { name: /^Needs you/ }).click();
  const card = page.getByTestId("needs-you-card").first();

  await card.waitFor({ timeout: 5_000 });
  await shoot(page, "needs-you-inbox");
  await card.getByRole("button", { name: /^Approve/ }).click();
  const answered = (await needsYouProbe())?.requests[0];

  await waitForProbe((p) => !p.requests.includes(answered ?? ""), "the answer");
  step(`approved ${answered} from the inbox; the request left the menu bar summary`);
  await page.getByRole("radio", { name: /^Sessions/ }).click();

  return 3;
};

/** macOS: closing the last window hides it; the star and its probe keep running. */
const closeKeepsRunning = async () => {
  if (process.platform !== "darwin") return;

  const after = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;

    win.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    return {
      windows: BrowserWindow.getAllWindows().length,
      destroyed: win.isDestroyed(),
      visible: win.isVisible(),
      star: globalThis.__polarisNeedsYou?.trayTitle() ?? null,
    };
  });

  if (after.windows !== 1 || after.destroyed || after.visible || after.star === null)
    throw new Error(`closing the window didn't keep Polaris running: ${JSON.stringify(after)}`);
  step("closed the window: hidden, the menu bar star still running");
};

/** Output stays as the user left it across a relaunch (the smoke-repo session's, left open). */
const relaunchKeepsOutput = async () => {
  await app.close();
  app = await launch();
  const page = await app.firstWindow();

  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 15_000 });
  await page
    .getByRole("button", { name: /smoke-repo/ })
    .first()
    .click();
  // The smoke session, not the Reviewer's session that reviewed it.
  await page
    .locator("[data-session-row]")
    .filter({ hasText: "bench:" })
    .filter({ hasNotText: "Reviewer ·" })
    .filter({ hasNotText: "Walkthrough ·" })
    .first()
    .click();
  await page.getByTestId("output-panel").waitFor({ timeout: 10_000 });
  step("a relaunch keeps output open for the session that had it open");

  return page;
};

/** Send an image and run a Subagent in the open session, relaunch, and find both again. */
const sentWorkSurvivesRelaunch = async (page: Page) => {
  await runSubagent(page, step);
  await sendImage(page, step);
  const again = await relaunchKeepsOutput();

  await imageAfterRelaunch(again, step);
  await subagentAfterRelaunch(again, step);
};

let failed = false;

const consoleErrors: Array<string> = [];

try {
  const page = await app.firstWindow();

  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    console.log(`smoke: request failed: ${request.url()} ${request.failure()?.errorText ?? ""}`)
  );
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await sizeWindow(app, 1280, 800);
  // Playwright emulates a light colour scheme by default; follow the app's own theme instead.
  await page.emulateMedia({ colorScheme: null });
  await onboarding(page);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 15_000 });
  step("local Host connected");

  const remote = page.getByTestId(`connection-${UNREACHABLE}`);

  await remote.waitFor({ timeout: 20_000 });
  step(`unreachable remote Host: ${await remote.textContent()}`);

  // A second, idle Workspace first, so the Workspace switch can be timed.
  await startProof();
  await page
    .locator('[data-testid="row-state"][data-state="idle"]')
    .first()
    .waitFor({ timeout: 60_000 });
  await startProof();
  await page.getByTestId("session-panel").waitFor({ timeout: 15_000 });
  step("proof session open");

  await page.getByTestId("live-item").first().waitFor({ timeout: 15_000 });
  step("live deltas streaming");

  await page
    .getByTestId("session-state")
    .filter({ hasText: /^Working/ })
    .waitFor({ timeout: 15_000 });
  await shoot(page, "proof");

  await page.getByTestId("session-state").filter({ hasText: /^Idle/ }).waitFor({ timeout: 60_000 });
  const items = await page.getByTestId("turn-item").count();

  step(`turn finished: ${items} items`);

  if (items !== 6) throw new Error(`expected 6 items, saw ${items}`);

  const repo = join(home, "smoke-repo");

  initRepo(repo);
  // Its remotes are how the PR list finds acme/widgets (and a repository nobody may see).
  addRemotes(repo, {
    origin: "git@github.com:acme/widgets.git",
    upstream: "https://github.com/lockedorg/vault",
  });
  // #42's commits come from a local code host, so its Review Checkout fetches for real.
  const codeHost = setupCodeHost(repo, home);

  // GitHub reports the code host's commits, so the checkout is at #42's head.
  setFakeHead(github.fake, 42, codeHost.head, codeHost.base);
  await sessionFlow({
    page,
    repo,
    step,
    shoot: (name) => shoot(page, name),
    atFirstApproval: () => inboxCheck(page),
  });
  await editorLinksFlow({ page, repo, step, shoot: (name) => shoot(page, name) });
  await composerFlow({ page, step });
  await settingsFlow({ app, page, step, shoot: (name) => shoot(page, name) });
  await terminalFlow({ page, step, shoot: (name) => shoot(page, name) });
  await attachmentsFlow({ app, page, step, shoot: (name) => shoot(page, name) });
  await extensionsFlow({ app, page, step, shoot: (name) => shoot(page, name) });
  await explorerFlow({ page, step, shoot: (name) => shoot(page, name) });
  await timeSwitches(page);
  await jumpByTyping(page);
  await githubFlow({
    page,
    fake: github.fake,
    step,
    afterList: async () => {
      await pullsFlow({ app, page, fake: github.fake, step });
      await reviewFlow({ page, fake: github.fake, step, shoot: (name) => shoot(page, name) });
      await findingsFlow({ page, fake: github.fake, step, shoot: (name) => shoot(page, name) });
      await checkoutFlow({
        page,
        fake: github.fake,
        codeHost,
        step,
        shoot: (name) => shoot(page, name),
      });
      await acceptFlow({
        page,
        fake: github.fake,
        repo,
        home,
        step,
        shoot: (name) => shoot(page, name),
      });
    },
  });
  await afterMerge({ page, step, shoot: (name) => shoot(page, name) });
  await cloneFlow({
    page,
    fake: github.fake,
    codeHostRoot: codeHost.root,
    userHome,
    step,
    shoot: (name) => shoot(page, name),
  });
  await githubEnterpriseFlow({
    page,
    fake: enterprise.fake,
    step,
    shoot: (name) => shoot(page, name),
  });

  // An Agent Session whose Turns change one file while other commits move HEAD (UB diffview 1).
  const sessionRepo = join(home, "review-session");

  initSessionRepo(sessionRepo);
  await runSessionTurns(page, sessionRepo);
  await checkSessionReview(page, step);
  await checkTurnPicker(page, step);
  await page.getByRole("radio", { name: /^Orchestrate/ }).click();

  let probeTimer: ReturnType<typeof setTimeout> | undefined;

  const probe = await Promise.race([
    page.evaluate(probeSource({ bigFile: bigAsset(), repo: REPO_ROOT })),
    new Promise((_, reject) => {
      probeTimer = setTimeout(async () => {
        const steps = await page.evaluate("JSON.stringify(window.__probeSteps)");

        reject(new Error(`RPC probe timed out after ${String(steps)}`));
      }, 20_000);
    }),
  ]).finally(() => clearTimeout(probeTimer));

  step(`RPC round trips: ${JSON.stringify(probe)}`);

  if (!JSON.stringify(probe).includes('"terminal":true'))
    throw new Error("terminal output missing");

  await reviewerFlow({ page, step });
  await reviewSettingsFlow({ page, step });

  const openHosts = async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Hosts" })
      .click();
    await page.getByTestId("hosts-settings").waitFor({ timeout: 10_000 });

    return true;
  };

  await machineFlow({
    page,
    host: fakeHost,
    step,
    openHosts,
    shoot: (name) => shoot(page, name),
  });

  if (consoleErrors.length > 0) throw new Error(`renderer errors:\n${consoleErrors.join("\n")}`);
  await constellationSetupFlow(page, step);
  await checkNoneReady(page, step);
  await closeKeepsRunning();
  await sentWorkSurvivesRelaunch(await relaunchKeepsOutput());
  step("ok");
} catch (error) {
  failed = true;
  console.error("smoke: FAILED", error);
  const page = app.windows()[0];

  if (page !== undefined) {
    const shot = join(tmpdir(), "polaris-smoke-failure.png");

    // Failure artifacts must not retain the one-time pairing credential.
    await page.evaluate(
      `document.querySelectorAll('[data-testid="pairing-reveal"]').forEach(element => element.replaceWith("[pairing credential hidden]"))`
    );
    await page.screenshot({ path: shot }).catch(() => undefined);
    console.error(
      `smoke: screenshot at ${shot}; screen text:\n${await page.locator("body").innerText()}`
    );
    console.error(`smoke: renderer errors:\n${consoleErrors.join("\n")}`);
  }
} finally {
  await app.close();
  await daemon.stop();
  fakeHost.stop();
  await github.close();
  await enterprise.close();
  rmSync(home, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
