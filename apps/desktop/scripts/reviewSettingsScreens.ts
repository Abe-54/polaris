#!/usr/bin/env node
/**
 * Screenshots of Settings for Review against Paper's S5 GitHub accounts, S6 Add GitHub
 * account and S7 Reviewer, plus Sessions' accept-branch group: three local Daemons for
 * three machines, a Workspace on each with a GitHub remote, and the GitHub fake served on
 * 127.0.0.1 (no real network or account). Needs a built app.
 *
 *   node scripts/reviewSettingsScreens.ts <out dir>
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import type { RequestInput, RequestMethod, RequestOutput } from "../src/shared/api.ts";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { MOCK_KEYCHAIN, serveGitHubFake } from "./lib/githubFlow.ts";
import { addRemotes } from "./lib/pullsFlow.ts";
import { initRepo } from "./lib/sessionFlow.ts";

const out = process.argv[2] ?? join(tmpdir(), "polaris-review-settings-screens");

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-review-settings-"));

const MACHINES = [
  { key: "vm", label: "Linux VM" },
  { key: "pi", label: "Raspberry Pi 4" },
] as const;

/** A Workspace per Host, each matched to GitHub by its remote. */
const REPOS = [
  { host: "local", name: "widgets", remote: "git@github.com:acme/widgets.git" },
  { host: "vm", name: "vault", remote: "https://github.com/lockedorg/vault" },
  { host: "pi", name: "dotfiles", remote: "https://github.com/mona/dotfiles.git" },
] as const;

const daemons = await Promise.all(
  ["local", ...MACHINES.map((m) => m.key)].map((key) =>
    startDaemon({ home: join(home, key), benchHarness: true })
  )
);

const [local, ...rest] = daemons;

const github = await serveGitHubFake();

const userData = join(home, "user-data");

mkdirSync(userData, { recursive: true });

writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", welcomeSeen: true })
);

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR, MOCK_KEYCHAIN],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: local?.socketPath ?? "",
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
    POLARIS_DESKTOP_EXTRA_HOSTS: JSON.stringify(
      MACHINES.map((m, i) => ({ ...m, socket: rest[i]?.socketPath ?? "" }))
    ),
    POLARIS_DESKTOP_USER_DATA: userData,
    POLARIS_DESKTOP_HIDDEN: "1",
    ...github.env,
  },
});

const call = <M extends RequestMethod>(page: Page, method: M, input: RequestInput<M>) =>
  page.evaluate<
    RequestOutput<M>
  >(`window.polaris.request(${JSON.stringify(method)}, ${JSON.stringify(input)}).then((r) => {
    if (!r.ok) throw new Error(r.error.code + ": " + r.error.message);
    return r.value;
  })`);

const setAppearance = async (page: Page, patch: Record<string, string>) => {
  await call(page, "settings.setAppearance", { patch });
  await page.waitForTimeout(400);
};

const shoot = async (page: Page, name: string) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`review-settings-screens: saved ${name}.png`);
};

/** Balanced and compact, dark; back to calm after. */
const densities = async (page: Page, name: string) => {
  for (const density of ["balanced", "compact"]) {
    await setAppearance(page, { density });
    await shoot(page, `${name}-dark-${density}`);
  }

  await setAppearance(page, { density: "calm" });
};

/** Both themes, dark first; back to dark after. */
const pair = async (page: Page, name: string) => {
  await shoot(page, `${name}-dark`);
  await setAppearance(page, { theme: "light" });
  await shoot(page, `${name}-light`);
  await setAppearance(page, { theme: "dark" });
};

const signIn = async (page: Page, login: string) => {
  await page.getByRole("button", { name: "Add account" }).click();
  const code = (await page.getByTestId("github-user-code").textContent()) ?? "";

  github.fake.approveDevice(code, login);
  await page.getByTestId("github-account").filter({ hasText: login }).waitFor({ timeout: 15_000 });
};

const nav = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page.emulateMedia({ colorScheme: null });
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });

  for (const repo of REPOS) {
    const dir = join(home, "repos", repo.host, repo.name);

    initRepo(dir);
    addRemotes(dir, { origin: repo.remote });
    await page
      .locator(`[data-host="${repo.host}"][data-connection="connected"]`)
      .waitFor({ timeout: 20_000 });
    await page.evaluate(
      `window.polaris.request("dispatch", { hostKey: ${JSON.stringify(repo.host)}, commandId: crypto.randomUUID(), command: { _tag: "RegisterWorkspace", path: ${JSON.stringify(dir)}, name: ${JSON.stringify(repo.name)} } })`
    );
  }

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings.open")?.click();
  });
  await page.getByTestId("settings").waitFor({ timeout: 5_000 });

  // S5 empty, then S6: the device-flow card, light as in Paper.
  await nav(page, "GitHub accounts");
  await pair(page, "S5-github-empty");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByTestId("github-sign-in").waitFor({ timeout: 10_000 });
  await setAppearance(page, { theme: "light" });
  await shoot(page, "S6-add-account-light");
  await setAppearance(page, { theme: "dark" });
  await shoot(page, "S6-add-account-dark");
  await densities(page, "S6-add-account");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("github-sign-in").waitFor({ state: "detached", timeout: 10_000 });

  // S5: two accounts, an owner mapped, a blocked org, a Workspace override.
  await signIn(page, "mona");
  await signIn(page, "hubot");
  await signIn(page, "octocat");
  github.fake.revoke("octocat");
  await call(page, "github.refresh", {});
  await page
    .getByTestId("github-account")
    .filter({ hasText: "Signed out" })
    .waitFor({ timeout: 30_000 })
    .catch(() => console.log("review-settings-screens: octocat not signed out yet"));
  await call(page, "github.routing.setOwner", { owner: "acme", accountId: 2002 });
  await page
    .getByTestId("github-owner")
    .filter({ hasText: "lockedorg" })
    .waitFor({ timeout: 30_000 });
  await pair(page, "S5-github-accounts");
  await densities(page, "S5-github-accounts");
  await page
    .getByTestId("github-account")
    .filter({ hasText: "hubot" })
    .getByRole("button")
    .last()
    .click();
  await shoot(page, "S5-account-menu-dark");
  await page.keyboard.press("Escape");

  // S7: Reviewer, automatic, then Codex GPT-6.1-Sol, then a Workspace override.
  await nav(page, "Reviewer");
  await page.getByTestId("reviewer-host").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
  await pair(page, "S7-reviewer-auto");
  // The bench Daemons list no GPT-6.1-Sol, so set it on each Host and reopen the page.

  for (const hostKey of ["local", ...MACHINES.map((m) => m.key)]) {
    await call(page, "review.setReviewerSettings", {
      hostKey,
      settings: {
        default: { harness: "codex", model: "gpt-6.1-sol", effort: "high" },
        workspaces: {},
        onPullRequests: true,
        onSessions: true,
        askAboveLines: 2000,
      },
    });
  }

  await nav(page, "Sessions");
  await nav(page, "Reviewer");
  await page
    .getByTestId("reviewer-title")
    .filter({ hasText: "Codex" })
    .waitFor({ timeout: 10_000 });
  await pair(page, "S7-reviewer-sol");
  await densities(page, "S7-reviewer-sol");
  await page.getByRole("region", { name: "When it runs" }).scrollIntoViewIfNeeded();
  await pair(page, "S7-reviewer-runs");
  await densities(page, "S7-reviewer-runs");
  await page.getByRole("button", { name: "Edit overrides" }).click();
  await page.getByRole("combobox", { name: /its own reviewer/ }).click();
  await page.getByRole("option", { name: "vault · Linux VM" }).click();
  await page.getByTestId("override").first().waitFor({ timeout: 10_000 });
  await page.getByTestId("override").first().scrollIntoViewIfNeeded();
  await shoot(page, "S7-reviewer-override-dark");

  // Sessions: where accepted work is committed, with one Workspace on main.
  await nav(page, "Sessions");
  await page.getByRole("combobox", { name: /commit differently/ }).click();
  await page.getByRole("option", { name: "widgets · Mac Studio" }).click();
  await page.getByRole("region", { name: "Accepting work" }).scrollIntoViewIfNeeded();
  await pair(page, "sessions-accept-branch");

  // The K menu's Settings actions for Review.
  await page.keyboard.press("Escape");
  await page.getByTestId("settings").waitFor({ state: "detached" });
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("github");
  await shoot(page, "k-menu-github-dark");
} finally {
  await app.close();
  await github.close();
  await Promise.all(daemons.map((d) => d.stop()));
  rmSync(home, { recursive: true, force: true });
}
