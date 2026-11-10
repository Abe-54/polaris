#!/usr/bin/env node
/**
 * Computer use approvals in the Desktop App on a real Daemon (Paper CU4): the bench Harness
 * asks an app and a headed-input approval; the transcript card answers them (Always allow on
 * the Host, Allow once), and the Daemon records those decisions. Both themes.
 *
 *   node scripts/computerUseApprovalScreens.ts --out <dir> [--build]
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

if (out === null)
  throw new Error("usage: node scripts/computerUseApprovalScreens.ts --out <dir> [--build]");

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "polaris-cua-"));

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

const asking = (kind: string) =>
  `bench:${JSON.stringify({ items: 1, approvalEvery: 1, deltaIntervalMs: 0, approvalApp: { kind, name: "Simulator" } })}`;

/** Registers the Workspace and starts a session asking each kind; resolves with their ids. */
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
  const start = async (title, prompt) => {
    const sessionId = crypto.randomUUID();
    await dispatch({ _tag: "StartSession", sessionId, workspaceId, harness: "claude",
      placement: { _tag: "InPlace" }, permissionMode: "supervised", model: null, effort: null,
      prompt, attachments: [] });
    await dispatch({ _tag: "RenameSession", sessionId, title });
    return sessionId;
  };
  const app = await start("Booking flow check", ${JSON.stringify(asking("app"))});
  const headed = await start("Export dialog check", ${JSON.stringify(asking("headed-input"))});
  return app + " " + headed;
})()`;

/** Listens, before the answer, for the decision the Daemon records for the session's approval. */
const listenSource = (sessionId: string) => `(() => {
  window.__decision = new Promise((resolve) => {
    const close = window.polaris.subscribe("session", { hostKey: "local", sessionId: ${JSON.stringify(sessionId)}, turnLimit: 1 }, { items: (items) => {
      for (const i of items) {
        if (i._tag === "Event" && i.envelope.event._tag === "ApprovalResolved") { close(); resolve(i.envelope.event.decision); return; }
      }
    } });
  });
})()`;

const shoot = async (page: Page, name: string) => {
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "${theme}" })`);
    await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
    await page.waitForTimeout(300);
    await page.getByTestId("app-approval").screenshot({ path: join(out, `${name}-${theme}.png`) });
  }

  await page.evaluate(`window.polaris.request("settings.setTheme", { theme: "dark" })`);
  console.log(`screens: ${name}`);
};

/** Answers the session's card and resolves with the decision the Daemon recorded. */
const answer = async (
  page: Page,
  sessionId: string,
  title: string,
  kind: string,
  button: string
) => {
  await page.getByText(title, { exact: true }).first().click();
  const card = page.locator(`[data-testid="app-approval"][data-kind="${kind}"]`);

  await card.waitFor({ timeout: 20_000 });
  await shoot(page, kind);
  await page.evaluate(listenSource(sessionId));
  await page.waitForTimeout(300);
  await card.getByRole("button", { name: button }).click();
  await card.waitFor({ state: "detached", timeout: 15_000 });

  return page.evaluate<string>("window.__decision.then((d) => JSON.stringify(d))");
};

const expectDecision = (seen: string, expected: string) => {
  if (seen !== expected) throw new Error(`expected ${expected}, the Daemon recorded ${seen}`);
  console.log(`decision: ${seen}`);
};

try {
  const page = await app.firstWindow();

  await sizeWindow(app, 1440, 900);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 15_000 });

  const repo = join(home, "code", "polaris");

  initRepo(repo);
  const [appId = "", headedId = ""] = (await page.evaluate<string>(startSource(repo))).split(" ");

  expectDecision(
    await answer(page, appId, "Booking flow check", "app", "Always allow on Mac Studio"),
    '{"_tag":"Allow","remember":true}'
  );
  expectDecision(
    await answer(page, headedId, "Export dialog check", "headed-input", "Allow once"),
    '{"_tag":"Allow","remember":false}'
  );
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
