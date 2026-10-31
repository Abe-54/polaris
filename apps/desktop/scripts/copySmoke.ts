/**
 * Every copy affordance in the real app, checked against the system clipboard (`pbpaste`):
 * node apps/desktop/scripts/copySmoke.ts (build first; macOS). Fixture scenes for an Agent
 * Session reply, Review's overview and Hosts; a real Daemon for the Markdown preview, the
 * ShellCheck Prerequisite (probes look in an empty root), the log tab and the file tree.
 * It uses the real clipboard: copying elsewhere while it runs fails a check.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { type Locator, type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-copy-")));

const userData = join(home, "user-data");

const project = join(home, "project");

const probeRoot = join(home, "empty-probes");

const evidence = join(REPO_ROOT, ".dagr/evidence/copy-button");

for (const path of [userData, project, probeRoot, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

writeFileSync(join(project, "package.json"), '{"name":"fixture","type":"module"}\n');

writeFileSync(join(project, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');

writeFileSync(join(project, "proof.ts"), "export const answer: number = 42;\n");

writeFileSync(join(project, "script.sh"), "#!/bin/bash\necho $value\n");

writeFileSync(
  join(project, "NOTES.md"),
  "# Notes\n\nRun it:\n\n```sh\nbun test forms --watch\n```\n"
);

const paste = () => execFileSync("pbpaste", { encoding: "utf8" });

// This writes the real clipboard: keep what was there and put it back at the end.
const kept = paste();

const clear = () => execFileSync("pbcopy", { input: "polaris-copy-smoke-cleared" });

const until = async (what: string, check: () => Promise<boolean>, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${what}`);
};

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

/** Clicks a CopyButton in each theme; it says Copied and the clipboard holds what it should. */
const check = async (
  page: Page,
  name: string,
  button: () => Locator,
  expected: (text: string) => boolean
) => {
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    clear();

    const target = button();

    await target.scrollIntoViewIfNeeded();
    await target.click();
    await until(
      `${name} copied`,
      async () => (await target.getAttribute("data-copy-state")) === "copied",
      10_000
    );
    // Let the 160ms cross-fade settle, so the evidence shows "Copied" alone.
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(evidence, `${name}-${theme}.png`) });

    const text = paste();

    assert.ok(expected(text), `${name}: the clipboard holds ${JSON.stringify(text)}`);
    await until(
      `${name} idle`,
      async () => (await target.getAttribute("data-copy-state")) === "idle",
      4000
    );
  }

  console.log(`copied: ${name}`);
};

const Durations = Schema.Array(Schema.String);

/** The button's and its first face's transition durations, as the page computes them. */
const durations = async (page: Page, selector: string) =>
  Schema.decodeUnknownSync(Durations)(
    await page.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const face = node.querySelector("[data-face]");
      return [getComputedStyle(node).transitionDuration, getComputedStyle(face).transitionDuration];
    })()`)
  );

/** DESIGN.md, Copy button: width holds, 120ms press and 160ms faces, quick clicks restart, Reduce Motion stills. */
const feel = async (page: Page, selector: string) => {
  const button = page.locator(selector);
  const width = async () => (await button.boundingBox())?.width ?? 0;
  const before = await width();

  assert.deepEqual(await durations(page, selector), ["0.12s", "0.16s"]);

  let last = 0;

  for (let click = 0; click < 5; click++) {
    await button.click();
    last = Date.now();
    await page.waitForTimeout(150);
    assert.equal(await button.getAttribute("data-copy-state"), "copied", `click ${click + 1}`);
  }

  assert.equal(await width(), before, "the width holds while it says Copied");
  await page.waitForTimeout(Math.max(0, last + 1000 - Date.now()));
  assert.equal(
    await button.getAttribute("data-copy-state"),
    "copied",
    "still Copied 1s after the last"
  );
  await until(
    "idle after the last click",
    async () => (await button.getAttribute("data-copy-state")) === "idle",
    2000
  );

  const idleAfter = Date.now() - last;

  assert.ok(idleAfter >= 1400 && idleAfter <= 2200, `idle ${idleAfter}ms after the last click`);

  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { motion: "reduce" } })`
  );
  await page.locator('html[data-reduce-motion="true"]').waitFor({ state: "attached" });
  assert.deepEqual(await durations(page, selector), ["0s", "0s"]);
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { motion: "system" } })`
  );
  console.log(
    "feel: width holds, 120/160ms, five clicks restart the 1.5s, Reduce Motion is instant"
  );
};

const scene = async (page: Page, hash: string, ready: string) => {
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}; location.reload()`);
  await page.waitForLoadState("domcontentloaded");
  await page.locator(ready).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
};

const open = async (page: Page, name: string, kind: string) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill(name);
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Enter");
  await page
    .locator(`[data-testid="editor-tab"][aria-selected="true"][title$="${name}"]`)
    .waitFor();
  await page
    .locator(`[data-testid="language-pill"][data-kind="${kind}"]`)
    .waitFor({ timeout: 180_000 });
};

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({
    home,
    benchHarness: true,
    env: { POLARIS_LANGUAGE_PYTHON_PROBE_ROOT: probeRoot },
  });
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

  await sizeWindow(app, 1280, 900);

  // An Agent Session reply: a code block, a table and a Mermaid source.
  await scene(page, "#preview/markdown", '[data-copy="table"]');
  await check(
    page,
    "session-code",
    () =>
      page
        .locator('[data-copy="code"]:not(:has([data-streamdown="mermaid-block"]))')
        .first()
        .getByRole("button", { name: "Copy code" }),
    (text) => text.trim().length > 0 && !text.includes("```")
  );
  await check(
    page,
    "session-table",
    () => page.getByRole("button", { name: "Copy table" }).first(),
    (text) => text.startsWith("|") && text.includes("| Replay |")
  );
  await check(
    page,
    "session-mermaid",
    () =>
      page
        .locator('[data-copy="code"]:has([data-streamdown="mermaid-block"])')
        .getByRole("button", { name: "Copy code" }),
    (text) => text.startsWith("graph LR")
  );

  // Review's overview: the description's fence.
  await scene(page, "#review/ov", '[data-copy="code"]');
  await check(
    page,
    "review-code",
    () => page.locator('[data-copy="code"]').first().getByRole("button", { name: "Copy code" }),
    (text) => text === "bun test forms"
  );

  // Settings → Hosts: a Host's "Copy command".
  await scene(page, "#hosts/failures", 'button[aria-label="Copy command"]');
  await check(
    page,
    "host-command",
    () => page.locator('button[aria-label="Copy command"]').first(),
    (text) => /sudo |ssh|curl|polaris/.test(text)
  );

  // The real app on a real Daemon.
  await page.evaluate(`location.hash = ""; location.reload()`);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 30_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "copy-proof"}})`
  );
  await page
    .getByRole("button", { name: /copy-proof/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");
  await page.getByTestId("explorer").waitFor({ timeout: 15_000 });

  // The file tree's "Copy path", answered in a toast.
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    clear();
    await page
      .getByTestId("tree-row")
      .filter({ has: page.getByText("proof.ts", { exact: true }) })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy path", exact: true }).click();
    await page.getByText("Copied path", { exact: true }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(evidence, `tree-path-${theme}.png`) });
    assert.equal(paste(), join(project, "proof.ts"));
    await page.getByText("Copied path", { exact: true }).waitFor({ state: "detached" });
  }

  console.log("copied: tree-path");

  // The Markdown preview's fence.
  await open(page, "NOTES.md", "syntax");
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Meta+Shift+V");
  await page.getByTestId("editor-markdown-preview").waitFor({ timeout: 20_000 });
  await check(
    page,
    "preview-code",
    () =>
      page
        .getByTestId("editor-markdown-preview")
        .locator('[data-copy="code"]')
        .getByRole("button", { name: "Copy code" }),
    (text) => text === "bun test forms --watch"
  );

  // The ShellCheck Prerequisite's command.
  await open(page, "script.sh", "prerequisite");
  await page.getByTestId("language-pill").click();
  await check(
    page,
    "shellcheck-command",
    () => page.getByTestId("language-popover").getByRole("button", { name: "Copy" }),
    (text) => text === "brew install shellcheck"
  );
  await feel(page, '[data-testid="language-popover"] button[aria-label="Copy"]');
  await page.keyboard.press("Escape");

  // The log tab's "Copy all".
  await open(page, "proof.ts", "ready");
  await page.getByTestId("language-pill").click();
  await page.getByTestId("language-popover").getByText("Show language server log").click();
  await page.getByRole("button", { name: "Copy all" }).waitFor({ timeout: 20_000 });
  await until("log lines", async () => (await page.getByRole("listitem").count()) > 0, 30_000);
  await check(
    page,
    "log-copy-all",
    () => page.getByRole("button", { name: "Copy all" }),
    (text) => text.split("\n").length >= 1 && text.trim().length > 0
  );

  console.log("PASS: every copy affordance writes to the clipboard and says so");
} finally {
  await app?.evaluate(({ app: electronApp }) => electronApp.exit()).catch(() => undefined);
  await daemon?.stop();
  execFileSync("pbcopy", { input: kept });
  rmSync(home, { recursive: true, force: true });
}
