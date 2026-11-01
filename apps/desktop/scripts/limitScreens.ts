#!/usr/bin/env node
/**
 * Screenshots of Limited sessions (Paper 16 / 16b) from a real Daemon: the bench Harness
 * stops one Turn at a usage limit with a reset time and one without; then Resume at reset
 * on, and Continue from Limited. Both themes; compare with the Paper artboards.
 *
 *   node scripts/limitScreens.ts --out <dir> [--build]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { seenUserData } from "./lib/userData.ts";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  electronBinary,
  sizeWindow,
} from "./lib/electron.ts";
import { initRepo } from "./lib/sessionFlow.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const out = at === -1 ? null : (args[at + 1] ?? null);

if (out === null) throw new Error("usage: node scripts/limitScreens.ts --out <dir> [--build]");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-limits-"));

const daemon = await startDaemon({ home, benchHarness: true, userHome: home });

const app = await electron.launch({
  executablePath: electronBinary(),
  args: [APP_DIR],
  env: {
    ...process.env,
    POLARIS_DESKTOP_LOCAL_SOCKET: daemon.socketPath,
    POLARIS_DESKTOP_LOCAL_LABEL: "Mac Studio",
    POLARIS_DESKTOP_BENCH_HARNESS: "1",
    POLARIS_DESKTOP_USER_DATA: seenUserData(join(home, "user-data")),
    POLARIS_DESKTOP_HIDDEN: "1",
  },
});

const limited = (resetsInMs: number) =>
  `bench:${JSON.stringify({ items: 3, deltasPerItem: 2, deltaIntervalMs: 1, usageLimit: true, usageLimitResetsInMs: resetsInMs })}`;

/** Registers the Workspace and starts two sessions that stop at a usage limit. */
const startSource = (repo: string) => `(async () => {
  const api = window.polaris;
  const must = (r, what) => { if (!r.ok) throw new Error(what + ": " + r.error.message); return r.value; };
  const dispatch = (command) =>
    api.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command }).then((r) => must(r, command._tag));
  await dispatch({ _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "polaris" });
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
  const start = async (harness, title, prompt) => {
    const sessionId = crypto.randomUUID();
    await dispatch({ _tag: "StartSession", sessionId, workspaceId, harness,
      placement: { _tag: "InPlace" }, permissionMode: "auto", model: null, effort: null,
      prompt, attachments: [] });
    await dispatch({ _tag: "RenameSession", sessionId, title });
  };
  await start("codex", "Migrate auth tests", ${JSON.stringify(limited(0))});
  await start("claude", "Polaris planning", ${JSON.stringify(limited(2 * 60 * 60 * 1000))});
})()`;

const appearance = async (page: Page, theme: "dark" | "light") => {
  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);
  await page.evaluate(`window.polaris.request("settings.setDensity", { density: "calm" })`);
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(300);
};

const shoot = async (page: Page, name: string) => {
  for (const theme of ["dark", "light"] as const) {
    await appearance(page, theme);
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
  }

  await appearance(page, "dark");
  console.log(`screens: ${name}`);
};

const open = async (page: Page, title: string) => {
  await page.getByText(title, { exact: true }).first().click();
  await page.getByTestId("limit-card").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 15_000 });

  const repo = join(home, "code", "polaris");

  initRepo(repo);
  await page.evaluate(startSource(repo));
  await page.getByText("Polaris planning", { exact: true }).first().waitFor({ timeout: 15_000 });

  await open(page, "Polaris planning");
  await shoot(page, "limited-resets");

  const toggle = page.getByRole("switch", { name: "Resume at reset" });

  if ((await toggle.getAttribute("aria-checked")) !== "false")
    throw new Error("Resume at reset should start off");
  await toggle.click();
  // The switch follows the Daemon's SessionResumeAtResetChanged, not local state.
  await page.locator('[role=switch][aria-checked="true"]').waitFor({ timeout: 10_000 });
  await page.getByText(/^Polaris continues this Turn at/).waitFor();
  await shoot(page, "limited-resume-on");

  await open(page, "Migrate auth tests");
  await shoot(page, "limited-unknown");

  await page.getByTestId("limit-card").getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("limit-card").waitFor({ state: "detached", timeout: 15_000 });
  await page.waitForTimeout(600);
  await shoot(page, "continued");
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
