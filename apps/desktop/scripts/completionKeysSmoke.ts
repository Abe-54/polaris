/**
 * ⌃Space and ⌃⇧Space in the real app, both themes:
 * node apps/desktop/scripts/completionKeysSmoke.ts [--out <dir>] (build first).
 * ⌃Space lists the file's words where no server answers (Markdown, plain text, a server still
 * setting up), the server's items once it is ready, in vim's insert mode too, and from the palette.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { startDaemon } from "./lib/daemon.ts";
import {
  scriptedElectron as electron,
  APP_DIR,
  REPO_ROOT,
  sizeWindow,
  stockElectronBinary,
} from "./lib/electron.ts";

const args = process.argv.slice(2);

const at = args.indexOf("--out");

const evidence = at === -1 ? join(REPO_ROOT, ".dagr/evidence/edmenu/run-1") : String(args[at + 1]);

const home = realpathSync(mkdtempSync(join(tmpdir(), "polaris-completion-keys-")));

const userData = join(home, "user-data");

const project = join(home, "project");

for (const path of [userData, project, evidence]) mkdirSync(path, { recursive: true });

writeFileSync(join(userData, "settings.json"), JSON.stringify({ welcomeSeen: true }));

writeFileSync(join(project, "package.json"), '{"name":"fixture","type":"module"}\n');

writeFileSync(
  join(project, "tsconfig.json"),
  '{"compilerOptions":{"strict":true,"target":"es2022","lib":["es2022","dom"]}}\n'
);

writeFileSync(join(project, "main.ts"), "const params = new URLSearchParams();\npar\n");

writeFileSync(join(project, "notes.md"), "# Release notes\n\nThe completion menu\ncomp\n");

writeFileSync(join(project, "plain.txt"), "alpha beta gamma\nal\n");

const appearance = async (page: Page, theme: string) => {
  await page.evaluate(
    `window.polaris.request("settings.setAppearance", { patch: { theme: "${theme}", density: "balanced" } })`
  );
  await page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(250);
};

const open = async (page: Page, name: string) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+P");
  await page.getByTestId("finder-input").fill(name);
  await page.getByTestId("finder-item").first().waitFor({ timeout: 20_000 });
  await page.keyboard.press("Enter");
  await page
    .locator(`[data-testid="editor-tab"][aria-selected="true"][title$="${name}"]`)
    .waitFor();
};

const menu = (page: Page) => page.locator(".cm-tooltip-autocomplete");

/** The caret at the end of `line` (0-based), then `press` (⌃Space by default). */
const complete = async (page: Page, line: number, press = async () => {}) => {
  await page.keyboard.press("Escape");
  await page.locator(".cm-line").nth(line).click();
  await page.keyboard.press("End");
  await press();
  await page.keyboard.press("Control+Space");
  await menu(page).locator("li").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(300);
  // CodeMirror parks a tooltip it clips at top -10000px: the menu must be on screen.
  const box = await menu(page).boundingBox();
  assert.ok(box !== null && box.y >= 0, `the menu is on screen (${JSON.stringify(box)})`);

  return {
    rows: await menu(page).locator("li").allTextContents(),
    footnote: (await menu(page).locator("[data-completion-footnote]").textContent()) ?? "",
  };
};

const shot = (page: Page, name: string) => page.screenshot({ path: join(evidence, `${name}.png`) });

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

let app: Awaited<ReturnType<typeof electron.launch>> | undefined;

try {
  daemon = await startDaemon({ home, benchHarness: true });
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

  await sizeWindow(app, 1280, 860);
  await page
    .locator('[data-host="local"][data-connection="connected"]')
    .waitFor({ timeout: 20_000 });
  await page.evaluate(
    `window.polaris.request("dispatch", {hostKey: "local", commandId: crypto.randomUUID(), command: {_tag: "RegisterWorkspace", path: ${JSON.stringify(project)}, name: "completion-keys"}})`
  );
  await page
    .getByRole("button", { name: /completion-keys/ })
    .first()
    .click();
  await page.keyboard.press("Meta+3");

  // Before TypeScript is ready, ⌃Space still answers, with the file's words.
  await open(page, "main.ts");
  const early = await complete(page, 1);
  assert.equal(early.footnote, "Words in this file", "setting up: words");
  assert.ok(early.rows.includes("params"), "setting up: params");
  await shot(page, "ts-setting-up-dark");

  await page
    .locator('[data-testid="language-pill"][data-kind="ready"]')
    .waitFor({ timeout: 180_000 });

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    const ready = await complete(page, 1);
    assert.match(ready.footnote, /TypeScript/, "ready: the server answers");
    await shot(page, `ts-ready-${theme}`);
  }

  // ⌃⇧Space: signature help at the caret.
  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    await page.keyboard.press("Escape");
    await page.locator(".cm-line").nth(1).click();
    await page.keyboard.press("End");
    await page.keyboard.type('ams.append("page", ', { delay: 30 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+Space");
    await page.locator("[data-signature-help] [data-doc-active]").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(300);
    await shot(page, `ts-signature-${theme}`);
    await page.keyboard.press("Escape");

    for (let index = 0; index < 3; index++) await page.keyboard.press("Meta+Z");
    assert.equal(await page.locator(".cm-line").nth(1).textContent(), "par", "signature: undone");
  }

  await open(page, "notes.md");

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);
    const words = await complete(page, 3);
    assert.equal(words.footnote, "Words in this file", "markdown: words");
    assert.ok(words.rows.includes("completion"), "markdown: completion");
    await shot(page, `md-words-${theme}`);
  }

  await page.evaluate(
    `window.polaris.request("settings.setSessions", { patch: { editorVim: true } })`
  );
  await page.waitForTimeout(1500);
  await open(page, "plain.txt");

  for (const theme of ["dark", "light"]) {
    await appearance(page, theme);

    const vim = await complete(page, 1, async () => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("A");
    });

    assert.ok(vim.rows.includes("alpha"), "vim insert: alpha");
    await shot(page, `txt-vim-insert-${theme}`);
  }

  // The palette lists both with their chords and runs completion at the caret.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Meta+P");
  await page.keyboard.type("show ");
  await page.waitForTimeout(400);
  const rows = await page.getByTestId("palette-row").allTextContents();
  await shot(page, "palette-show-light");
  assert.ok(
    rows.some((row) => row.includes("Show completions") && row.includes("⌃Space")),
    `palette: ${rows.join(" | ")}`
  );
  await page.keyboard.press("Escape");

  console.log(`completion keys checked; evidence in ${evidence}`);
} finally {
  await app?.close();
  await daemon?.stop();
}
