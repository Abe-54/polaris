#!/usr/bin/env node
/**
 * Intent groups in Review (Paper R11, R11b), on the built app and a real Daemon on the bench
 * Harness: one Turn writes code, a test, docs, config, a manifest and a lockfile. The file
 * list opens in Path order; Intent groups by path until the Walkthrough runs, then by its
 * groups; "By intent" regroups the diff; both choices hold across a relaunch.
 *
 *   node scripts/reviewGroupsScreens.ts [--build] --out <dir>
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import { scriptedElectron as electron, APP_DIR, electronBinary } from "./lib/electron.ts";
import { seenUserData } from "./lib/userData.ts";

const args = process.argv.slice(2);

const outAt = args.indexOf("--out");

const out = outAt === -1 ? null : (args[outAt + 1] ?? null);

if (out === null) throw new Error("usage: reviewGroupsScreens.ts [--build] --out <dir>");

mkdirSync(out, { recursive: true });

if (args.includes("--build"))
  spawnSync("bun", [join(APP_DIR, "scripts/build.ts"), "--no-app"], { stdio: "inherit" });

const git = (cwd: string, ...rest: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=s", "-c", "user.email=s@polaris.invalid", ...rest], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();

const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const home = mkdtempSync(join(tmpdir(), "polaris-review-groups-"));

const repo = join(home, "repo");

mkdirSync(repo, { recursive: true });

git(repo, "init", "-q", "-b", "main");

write(repo, "README.md", "# limits\n");

git(repo, "add", ".");

git(repo, "commit", "-qm", "init");

/** What the Turn writes while it runs, so its after-checkpoint holds them. */
const writeChange = () => {
  write(repo, "src/limits.ts", "export const limit = (n: number) => 2 * n;\n");
  write(repo, "src/apply.ts", 'import { limit } from "./limits";\nexport const apply = limit;\n');
  write(repo, "src/limits.test.ts", 'test("limit", () => expect(limit(2)).toBe(4));\n');
  write(repo, "docs/limits.md", "# Limits\n\nTwice the household size.\n");
  write(repo, "tsconfig.json", '{ "compilerOptions": { "strict": true } }\n');
  write(repo, "package.json", '{ "name": "limits", "version": "1.1.0" }\n');
  write(
    repo,
    "bun.lock",
    Array.from({ length: 50 }, (_, i) => `"pkg-${i}": ["pkg-${i}@1.0.${i}"],`).join("\n")
  );
};

const bench = `bench:${JSON.stringify({ items: 1, deltasPerItem: 1, deltaIntervalMs: 1, startDelayMs: 3000 })}`;

const startSource = `(async () => {
  const api = window.polaris;
  const must = (r, what) => { if (!r.ok) throw new Error(what + ": " + r.error.message); return r.value; };
  const dispatch = (command) =>
    api.request("dispatch", { hostKey: "local", commandId: crypto.randomUUID(), command }).then((r) => must(r, command._tag));
  await dispatch({ _tag: "RegisterWorkspace", path: ${JSON.stringify(repo)}, name: "limits" });
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
  await dispatch({ _tag: "StartSession", sessionId, workspaceId, harness: "claude",
    placement: { _tag: "InPlace" }, permissionMode: "auto", model: null, effort: null,
    prompt: ${JSON.stringify(bench)}, attachments: [] });
  await dispatch({ _tag: "RenameSession", sessionId, title: "Double the limit" });
  return sessionId;
})()`;

const waitForTurn = async (sessionId: string) => {
  for (let i = 0; i < 150; i++) {
    const refs = git(
      repo,
      "for-each-ref",
      "--format=%(refname)",
      `refs/polaris/checkpoints/${sessionId}`
    );

    if (refs.split("\n").some((r) => r.endsWith("/after"))) return;

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("the Turn never finished");
};

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
};

const shootBoth = async (page: Page, name: string) => {
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
  }
};

const groups = (page: Page) => page.getByTestId("review-group").allInnerTexts();

const daemon = await startDaemon({ home, benchHarness: true });

const launch = () =>
  electron.launch({
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

// Ask first above one changed line: the Walkthrough waits, so groups start by path.
const askFirst = `(async () => {
  const r = await window.polaris.request("review.setReviewerSettings", { hostKey: "local",
    settings: { default: null, workspaces: {}, onPullRequests: true, onSessions: true, askAboveLines: 1 } });
  if (!r.ok) throw new Error(r.error.message);
})()`;

const openReview = async (page: Page) => {
  await page.getByRole("radio", { name: /^Orchestrate/ }).click();
  await page.getByRole("button", { name: /^Jump to/ }).click();
  await page.keyboard.type("Double the limit");
  await page.getByTestId("jump-item").filter({ hasText: "Double the limit" }).first().waitFor();
  await page.keyboard.press("Meta+Enter");
  await page.getByTestId("session-review").waitFor();
  await page.getByTestId("review-tab-changes").click();
  await page
    .getByTestId("review-file-row")
    .or(page.getByTestId("review-group"))
    .first()
    .waitFor({ timeout: 30_000 });
};

let app = await launch();

const errors: Array<string> = [];

try {
  let page = await app.firstWindow();

  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("radio", { name: /^Review/ }).waitFor();

  const sessionId = String(await page.evaluate(startSource));

  await new Promise((resolve) => setTimeout(resolve, 1000));
  writeChange();
  await waitForTurn(sessionId);
  await page.evaluate(askFirst);
  await openReview(page);

  // Path by default; By turn by default.
  await page
    .getByRole("radio", { name: "Path", exact: true })
    .and(page.locator("[data-state=on]"))
    .waitFor();
  await page.getByRole("radio", { name: "By turn" }).and(page.locator("[data-state=on]")).waitFor();
  await shootBoth(page, "path");

  await page.getByRole("radio", { name: "Intent", exact: true }).click();
  await page.getByTestId("review-grouped-by-path").waitFor();
  console.log(`review-groups: by path → ${(await groups(page)).join(" | ")}`);
  await shootBoth(page, "intent-by-path");

  await page.getByTestId("review-tab-overview").click();
  await page.getByTestId("walkthrough-run").click();
  await page
    .locator('[data-testid="walkthrough"][data-state="ready"]')
    .waitFor({ timeout: 60_000 });
  await page.getByTestId("review-tab-changes").click();
  await page.getByTestId("review-grouped-by-path").waitFor({ state: "detached", timeout: 30_000 });
  console.log(`review-groups: by intent → ${(await groups(page)).join(" | ")}`);
  await shootBoth(page, "intent-walkthrough");

  await page.getByRole("radio", { name: "By intent" }).click();
  await page.getByTestId("turn-divider").first().waitFor();

  const dividers = await page.getByTestId("turn-divider").allInnerTexts();

  console.log(`review-groups: diff by intent → ${dividers.join(" | ")}`);
  await shootBoth(page, "diff-by-intent");

  // Remembered on this Mac: a new window, same user data.
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("radio", { name: /^Review/ }).waitFor();
  await openReview(page);
  await page
    .getByRole("radio", { name: "Intent", exact: true })
    .and(page.locator("[data-state=on]"))
    .waitFor();
  await page
    .getByRole("radio", { name: "By intent" })
    .and(page.locator("[data-state=on]"))
    .waitFor();
  console.log("review-groups: after relaunch → Intent, By intent");
  console.log(
    `review-groups: OK${errors.length > 0 ? ` (page errors: ${errors.join("; ")})` : ""}`
  );
} catch (cause) {
  const page = await app.firstWindow();

  await page.screenshot({ path: join(out, "failed.png") });
  console.log(`review-groups: FAILED ${String(cause)}\n${errors.join("\n")}`);
  process.exitCode = 1;
} finally {
  await app.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
}
